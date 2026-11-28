import datetime
import gc
import os
import tempfile
import unittest

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from database import Base
    from models import User, Binder, ProductPurchase, Setting
    DEPS = True
except ModuleNotFoundError:
    DEPS = False


@unittest.skipUnless(DEPS, "SQLAlchemy not installed in this lightweight test environment")
class PublicBindersModelTests(unittest.TestCase):
    def _db(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine)()

    def test_new_columns_default_private(self):
        db = self._db()
        user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        binder = Binder(name="Binder", binder_type="collection")
        db.add_all([user, binder])
        db.commit()
        db.refresh(user)
        db.refresh(binder)
        self.assertIsNone(user.public_handle)
        self.assertFalse(user.is_profile_public)
        self.assertFalse(user.public_show_values)
        self.assertEqual(user.wishlist_visibility, "private")
        self.assertFalse(user.public_default_new_binders)
        self.assertFalse(user.public_show_all_owned_cards)
        self.assertFalse(binder.is_public)


try:
    from services.public_profile import (
        HandleError,
        migrate_public_profile_handles,
        public_handle_from_trainer_name,
        validate_handle,
    )
    SERVICE_DEPS = True
except ModuleNotFoundError:
    SERVICE_DEPS = False


@unittest.skipUnless(SERVICE_DEPS, "service deps unavailable")
class HandleValidationTests(unittest.TestCase):
    def test_valid_handle_is_normalized(self):
        self.assertEqual(validate_handle("  Ash-Ketchum "), "ash-ketchum")

    def test_too_short_rejected(self):
        with self.assertRaises(HandleError):
            validate_handle("ab")

    def test_bad_chars_rejected(self):
        with self.assertRaises(HandleError):
            validate_handle("ash_ketchum")

    def test_leading_hyphen_rejected(self):
        with self.assertRaises(HandleError):
            validate_handle("-ash")

    def test_double_hyphen_rejected(self):
        with self.assertRaises(HandleError):
            validate_handle("ash--ketchum")

    def test_reserved_rejected(self):
        with self.assertRaises(HandleError):
            validate_handle("admin")

    def test_trainer_name_normalizes_common_latin_diacritics(self):
        self.assertEqual(public_handle_from_trainer_name("  Gilles Romér!  "), "gilles-romer")

    def test_problematic_trainer_name_is_rejected(self):
        with self.assertRaises(HandleError):
            public_handle_from_trainer_name("🔥")

    def test_reserved_trainer_name_is_rejected(self):
        with self.assertRaises(HandleError):
            public_handle_from_trainer_name("Admin")


try:
    from services import public_profile as pp
    from models import BinderCard, Card, CollectionItem, PrintingDetailTag, Set, WishlistItem
    PP_DEPS = True
except ModuleNotFoundError:
    PP_DEPS = False


@unittest.skipUnless(PP_DEPS, "service deps unavailable")
class SerializationTests(unittest.TestCase):
    def _db(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine)()

    def _seed(self, db, *, profile_public=True, binder_public=True, show_values=False):
        user = User(username="ash", hashed_password="x", role="trainer", is_active=True,
                    public_handle="ash", is_profile_public=profile_public, public_show_values=show_values)
        db.add_all([
            user,
            Set(id="sv1_en", tcg_set_id="sv1", name="Scarlet & Violet", lang="en", total=1),
            Card(id="sv1-1_en", tcg_card_id="sv1-1", name="Sprigatito", set_id="sv1",
                 number="1", lang="en", rarity="Common", images_small="https://img/s.webp",
                 price_trend=5.0),
        ])
        db.commit()
        binder = Binder(name="Starters", user_id=user.id, binder_type="collection", is_public=binder_public)
        db.add(binder)
        db.commit()
        db.add(BinderCard(binder_id=binder.id, card_id="sv1-1_en", required_quantity=2))
        db.commit()
        return user, binder

    def test_get_live_profile_requires_public(self):
        db = self._db()
        self._seed(db, profile_public=False)
        self.assertIsNone(pp.get_live_profile(db, "ash"))

    def test_serialize_profile_lists_only_public_binders(self):
        db = self._db()
        user, _ = self._seed(db, binder_public=False)
        data = pp.serialize_profile(db, user)
        self.assertEqual(data["trainer_name"], "ash")
        self.assertEqual(data["binders"], [])

    def test_binder_detail_hides_values_when_off(self):
        db = self._db()
        _, binder = self._seed(db, show_values=False)
        detail = pp.serialize_binder_detail(db, binder, show_values=False)
        self.assertEqual(detail["cards"][0]["name"], "Sprigatito")
        self.assertEqual(detail["cards"][0]["image"], "/api/images/card/sv1-1_en/small")
        self.assertEqual(detail["cards"][0]["quantity"], 2)
        self.assertIsNone(detail["cards"][0]["market_value"])
        self.assertIsNone(detail["total_value"])

    def test_public_card_includes_fallback_metadata_without_exposing_custom_url(self):
        db = self._db()
        _, binder = self._seed(db, show_values=False)
        card = db.query(Card).filter(Card.id == "sv1-1_en").one()
        card.data_source_lang = "fr"
        card.price_source_lang = "de"
        card.image_source_lang = "ja"
        card.images_small = None
        card.images_large = None
        card.custom_image_url = "https://private.example/manual.webp"
        db.commit()

        public_card = pp.serialize_binder_detail(db, binder, show_values=False)["cards"][0]

        self.assertEqual(public_card["data_source_lang"], "fr")
        self.assertEqual(public_card["price_source_lang"], "de")
        self.assertEqual(public_card["image_source_lang"], "ja")
        self.assertTrue(public_card["has_custom_image_fallback"])
        self.assertNotIn("custom_image_url", public_card)

    def test_public_card_proxy_url_encodes_custom_identifiers(self):
        self.assertEqual(
            pp._public_card_image_url("custom card#1"),
            "/api/images/card/custom%20card%231/small",
        )

    def test_public_binder_marks_manual_cards(self):
        db = self._db()
        user, binder = self._seed(db, show_values=False)
        card = db.query(Card).filter(Card.id == "sv1-1_en").one()
        card.is_custom = True
        card.custom_owner_id = user.id
        db.commit()

        public_card = pp.serialize_binder_detail(db, binder, show_values=False)["cards"][0]

        self.assertTrue(public_card["is_custom"])

    def test_binder_detail_shows_values_when_on(self):
        db = self._db()
        _, binder = self._seed(db, show_values=True)
        detail = pp.serialize_binder_detail(db, binder, show_values=True)
        self.assertEqual(detail["cards"][0]["market_value"], 5.0)
        self.assertEqual(detail["total_value"], 10.0)  # 5.0 * qty 2

    def test_no_private_fields_leak(self):
        db = self._db()
        _, binder = self._seed(db, show_values=True)
        detail = pp.serialize_binder_detail(db, binder, show_values=True)
        card = detail["cards"][0]
        for banned in ("purchase_price", "condition", "user_id", "username", "custom_image_url"):
            self.assertNotIn(banned, card)

    def test_serialized_card_includes_variant(self):
        from models import CollectionItem
        db = self._db()
        _, binder = self._seed(db)
        # Link the binder card to a collection item carrying a variant.
        item = CollectionItem(card_id="sv1-1_en", user_id=1, quantity=2,
                              variant="Reverse Holo", condition="NM")
        item.printing_detail_tags = [PrintingDetailTag(
            user_id=1,
            name="Poké Ball Holo",
            normalized_name="poke ball holo",
            normalized_key="6f90b59791feb602c69b4ae49387f5878a65a9297448fd21d7d867f47f7bbfb9",
        )]
        db.add(item)
        db.commit()
        bc = db.query(BinderCard).filter(BinderCard.binder_id == binder.id).first()
        bc.collection_item_id = item.id
        db.commit()
        detail = pp.serialize_binder_detail(db, binder, show_values=False)
        self.assertEqual(detail["cards"][0]["variant"], "Reverse Holo")
        self.assertEqual(detail["cards"][0]["printing_details"], ["Poké Ball Holo"])
        self.assertEqual(detail["cards"][0]["lang"], "en")

    def test_serialized_card_variant_defaults_none_without_collection_item(self):
        db = self._db()
        _, binder = self._seed(db)  # seed BinderCard has no collection_item_id
        detail = pp.serialize_binder_detail(db, binder, show_values=False)
        self.assertIsNone(detail["cards"][0]["variant"])

    def test_binder_detail_orders_by_card_number_naturally(self):
        from datetime import datetime
        db = self._db()
        _, binder = self._seed(db)  # seed card is number "1", added first
        # Add cards whose numbers, sorted as strings, would interleave wrongly
        # (10 before 2), and whose add order is the reverse of number order.
        db.add_all([
            Card(id="sv1-10_en", tcg_card_id="sv1-10", name="Ten", set_id="sv1",
                 number="10", lang="en", rarity="Common", price_trend=1.0),
            Card(id="sv1-2_en", tcg_card_id="sv1-2", name="Two", set_id="sv1",
                 number="2", lang="en", rarity="Common", price_trend=1.0),
        ])
        db.commit()
        db.query(BinderCard).filter(BinderCard.binder_id == binder.id).first().added_at = datetime(2026, 1, 1)
        db.add(BinderCard(binder_id=binder.id, card_id="sv1-10_en", required_quantity=1, added_at=datetime(2026, 2, 1)))
        db.add(BinderCard(binder_id=binder.id, card_id="sv1-2_en", required_quantity=1, added_at=datetime(2026, 3, 1)))
        db.commit()
        detail = pp.serialize_binder_detail(db, binder, show_values=False)
        self.assertEqual([c["number"] for c in detail["cards"]], ["1", "2", "10"])


@unittest.skipUnless(PP_DEPS, "service deps unavailable")
class ProfileCardsSerializationTests(unittest.TestCase):
    def _db(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine)()

    def _user(self, db, *, username="ash", handle="ash", public=True, active=True, show_values=False, all_owned=False):
        user = User(
            username=username,
            hashed_password="x",
            role="trainer",
            is_active=active,
            public_handle=handle,
            is_profile_public=public,
            public_show_values=show_values,
            public_show_all_owned_cards=all_owned,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return user

    def _set(self, db, set_id="sv1", name="Scarlet & Violet", abbreviation="SVI"):
        db.add(Set(
            id=f"{set_id}_en",
            tcg_set_id=set_id,
            name=name,
            lang="en",
            total=10,
            abbreviation=abbreviation,
        ))
        db.commit()

    def _card(self, db, card_id, *, set_id="sv1", number="1", name="Sprigatito",
              price=5.0, is_custom=False, owner_id=None, lang="en"):
        db.add(Card(
            id=card_id,
            tcg_card_id=None if is_custom else card_id.rsplit("_", 1)[0],
            name=name,
            set_id=set_id,
            number=number,
            lang=lang,
            rarity="Common",
            images_small=f"https://img/{card_id}.webp",
            price_trend=price,
            is_custom=is_custom,
            custom_owner_id=owner_id,
        ))
        db.commit()

    def _binder(self, db, user, name="Binder", *, public=True, binder_type="collection"):
        binder = Binder(
            name=name,
            user_id=user.id,
            binder_type=binder_type,
            is_public=public,
        )
        db.add(binder)
        db.commit()
        db.refresh(binder)
        return binder

    def _item(self, db, user, card_id, *, quantity=1, variant="Normal"):
        item = CollectionItem(
            card_id=card_id,
            user_id=user.id,
            quantity=quantity,
            variant=variant,
            condition="NM",
        )
        db.add(item)
        db.commit()
        db.refresh(item)
        return item

    def _add(self, db, binder, card_id, *, quantity=1, item=None):
        bc = BinderCard(
            binder_id=binder.id,
            card_id=card_id,
            required_quantity=quantity,
            collection_item_id=item.id if item else None,
        )
        db.add(bc)
        db.commit()
        db.refresh(bc)
        return bc

    def test_union_sums_binder_allocations_not_owned_quantities(self):
        db = self._db()
        user = self._user(db, show_values=True)
        self._set(db)
        self._card(db, "sv1-1_en", price=4.0)
        # The owner has 10 copies, but only the 2 + 3 copies allocated to public
        # collection binders may contribute.
        item = self._item(db, user, "sv1-1_en", quantity=10)
        first = self._binder(db, user, "First")
        second = self._binder(db, user, "Second")
        self._add(db, first, "sv1-1_en", quantity=2, item=item)
        self._add(db, second, "sv1-1_en", quantity=3, item=item)

        data = pp.serialize_profile_cards(db, user)

        self.assertEqual(len(data["cards"]), 1)
        card = data["cards"][0]
        self.assertEqual(card["quantity"], 5)
        self.assertEqual(card["market_value"], 4.0)
        self.assertEqual(data["card_count"], 5)
        self.assertEqual(data["unique_card_count"], 1)
        self.assertEqual(data["total_value"], 20.0)

    def test_none_and_normal_variants_remain_distinct(self):
        db = self._db()
        user = self._user(db)
        self._set(db)
        self._card(db, "sv1-1_en")
        normal_item = self._item(db, user, "sv1-1_en", quantity=10, variant="Normal")
        first = self._binder(db, user, "First")
        second = self._binder(db, user, "Second")
        self._add(db, first, "sv1-1_en", quantity=2, item=normal_item)
        self._add(db, second, "sv1-1_en", quantity=1)

        data = pp.serialize_profile_cards(db, user)

        self.assertEqual(len(data["cards"]), 2)
        self.assertEqual({card["variant"] for card in data["cards"]}, {None, "Normal"})
        self.assertEqual(sorted(card["quantity"] for card in data["cards"]), [1, 2])
        self.assertEqual(data["card_count"], 3)
        self.assertEqual(data["unique_card_count"], 2)

    def test_only_public_collection_binders_of_this_owner_are_unioned(self):
        db = self._db()
        user = self._user(db)
        other = self._user(db, username="misty", handle="misty")
        self._set(db)
        for card_id in ("sv1-1_en", "sv1-2_en", "sv1-3_en", "sv1-4_en"):
            self._card(db, card_id)

        self._add(db, self._binder(db, user, "Public"), "sv1-1_en", quantity=1)
        self._add(db, self._binder(db, user, "Private", public=False), "sv1-2_en", quantity=1)
        self._add(db, self._binder(db, user, "Wishlist", binder_type="wishlist"), "sv1-3_en", quantity=1)
        self._add(db, self._binder(db, other, "OtherOwner"), "sv1-4_en", quantity=1)

        data = pp.serialize_profile_cards(db, user)

        self.assertEqual([card["id"] for card in data["cards"]], ["sv1-1_en"])
        self.assertEqual(data["card_count"], 1)

    def test_empty_profile_returns_empty_cards(self):
        db = self._db()
        user = self._user(db, show_values=True)
        data = pp.serialize_profile_cards(db, user)
        self.assertEqual(data["cards"], [])
        self.assertEqual(data["card_count"], 0)
        self.assertEqual(data["unique_card_count"], 0)
        self.assertEqual(data["total_value"], 0.0)

    def test_values_are_hidden_when_flag_off(self):
        db = self._db()
        user = self._user(db, show_values=False)
        self._set(db)
        self._card(db, "sv1-1_en", price=7.0)
        self._add(db, self._binder(db, user), "sv1-1_en", quantity=1)

        data = pp.serialize_profile_cards(db, user)

        self.assertFalse(data["show_values"])
        self.assertIsNone(data["cards"][0]["market_value"])
        self.assertIsNone(data["total_value"])

    def test_cards_use_natural_collector_order_across_binders(self):
        db = self._db()
        user = self._user(db)
        self._set(db)
        for number in ("10", "2", "1"):
            self._card(db, f"sv1-{number}_en", number=number, name=f"Card {number}")
        first = self._binder(db, user, "First")
        second = self._binder(db, user, "Second")
        self._add(db, first, "sv1-10_en", quantity=1)
        self._add(db, second, "sv1-2_en", quantity=1)
        self._add(db, second, "sv1-1_en", quantity=1)

        data = pp.serialize_profile_cards(db, user)

        self.assertEqual([card["number"] for card in data["cards"]], ["1", "2", "10"])

    def test_custom_cards_are_listed_without_private_fields(self):
        db = self._db()
        user = self._user(db, show_values=True)
        self._card(
            db,
            "custom card#1",
            set_id=None,
            number=None,
            name="My custom card",
            is_custom=True,
            owner_id=user.id,
        )
        card = db.query(Card).filter(Card.id == "custom card#1").one()
        card.custom_image_url = "https://private.example/manual.webp"
        card.images_small = None
        card.images_large = None
        db.commit()
        self._add(db, self._binder(db, user), "custom card#1", quantity=1)

        data = pp.serialize_profile_cards(db, user)

        public_card = data["cards"][0]
        self.assertTrue(public_card["is_custom"])
        self.assertIsNone(public_card["set_id"])
        self.assertTrue(public_card["has_custom_image_fallback"])
        self.assertEqual(
            public_card["image"],
            "/api/images/card/custom%20card%231/small",
        )
        for banned in ("purchase_price", "condition", "user_id", "username", "custom_image_url"):
            self.assertNotIn(banned, public_card)

    def test_cards_from_disabled_languages_are_still_listed(self):
        db = self._db()
        db.add(Setting(key="tcgdex_sync_languages", value="en"))
        db.commit()
        user = self._user(db)
        self._card(db, "sv1-1_ja", lang="ja")
        self._add(db, self._binder(db, user), "sv1-1_ja", quantity=1)

        data = pp.serialize_profile_cards(db, user)

        self.assertEqual([card["id"] for card in data["cards"]], ["sv1-1_ja"])
        self.assertEqual(data["cards"][0]["lang"], "ja")
    def test_all_owned_cards_use_full_quantity_without_double_counting_linked_binder_rows(self):
        db = self._db()
        user = self._user(db, show_values=True, all_owned=True)
        self._set(db)
        self._card(db, "sv1-1_en", price=4.0)
        item = self._item(db, user, "sv1-1_en", quantity=5)
        self._add(db, self._binder(db, user), "sv1-1_en", quantity=2, item=item)

        data = pp.serialize_profile_cards(db, user)

        self.assertTrue(data["all_owned_cards"])
        self.assertEqual(len(data["cards"]), 1)
        self.assertEqual(data["cards"][0]["quantity"], 5)  # not 2 and not 7
        self.assertEqual(data["cards"][0]["market_value"], 4.0)
        self.assertEqual(data["card_count"], 5)
        self.assertEqual(data["unique_card_count"], 1)
        self.assertEqual(data["total_value"], 20.0)

    def test_all_owned_cards_include_outside_and_private_binder_items_only_when_enabled(self):
        db = self._db()
        user = self._user(db, all_owned=False)
        self._set(db)
        for card_id, number in (("sv1-1_en", "1"), ("sv1-2_en", "2"), ("sv1-3_en", "3")):
            self._card(db, card_id, number=number)

        self._item(db, user, "sv1-1_en", quantity=2)  # owned outside any binder
        private_item = self._item(db, user, "sv1-2_en", quantity=3)
        private = self._binder(db, user, "Private", public=False)
        self._add(db, private, "sv1-2_en", quantity=1, item=private_item)
        binder_only = self._binder(db, user, "Public")
        self._add(db, binder_only, "sv1-3_en", quantity=1)

        allocation_only = pp.serialize_profile_cards(db, user)
        self.assertFalse(allocation_only["all_owned_cards"])
        self.assertEqual([card["id"] for card in allocation_only["cards"]], ["sv1-3_en"])

        user.public_show_all_owned_cards = True
        db.commit()
        all_owned = pp.serialize_profile_cards(db, user)

        self.assertTrue(all_owned["all_owned_cards"])
        self.assertEqual(
            [(card["id"], card["quantity"]) for card in all_owned["cards"]],
            [("sv1-1_en", 2), ("sv1-2_en", 3), ("sv1-3_en", 1)],
        )

    def test_all_owned_cards_group_full_quantities_and_keep_none_distinct(self):
        db = self._db()
        user = self._user(db, all_owned=True)
        self._set(db)
        self._card(db, "sv1-1_en")
        self._item(db, user, "sv1-1_en", quantity=2, variant="Normal")
        self._item(db, user, "sv1-1_en", quantity=4, variant="Normal")
        self._item(db, user, "sv1-1_en", quantity=3, variant="Holo")
        self._add(db, self._binder(db, user), "sv1-1_en", quantity=1)  # unlinked -> None

        data = pp.serialize_profile_cards(db, user)

        self.assertEqual(
            {card["variant"]: card["quantity"] for card in data["cards"]},
            {None: 1, "Normal": 6, "Holo": 3},
        )
        self.assertEqual(data["card_count"], 10)
        self.assertEqual(data["unique_card_count"], 3)

    def test_all_owned_cards_exclude_wishlist_items_and_other_users(self):
        db = self._db()
        user = self._user(db, all_owned=True)
        other = self._user(db, username="misty", handle="misty")
        self._set(db)
        for card_id, number in (("sv1-1_en", "1"), ("sv1-2_en", "2"),
                                ("sv1-3_en", "3"), ("sv1-4_en", "4")):
            self._card(db, card_id, number=number)

        self._item(db, user, "sv1-1_en", quantity=1)
        db.add(WishlistItem(card_id="sv1-2_en", user_id=user.id, quantity=5))
        db.commit()
        self._item(db, other, "sv1-3_en", quantity=2)
        self._add(db, self._binder(db, user), "sv1-4_en", quantity=1)

        data = pp.serialize_profile_cards(db, user)

        self.assertEqual(
            [(card["id"], card["quantity"]) for card in data["cards"]],
            [("sv1-1_en", 1), ("sv1-4_en", 1)],
        )

    def test_all_owned_cards_keep_custom_and_disabled_language_cards(self):
        db = self._db()
        db.add(Setting(key="tcgdex_sync_languages", value="en"))
        db.commit()
        user = self._user(db, all_owned=True)
        self._card(
            db,
            "custom card#1",
            set_id=None,
            number=None,
            name="My custom card",
            is_custom=True,
            owner_id=user.id,
        )
        self._card(db, "sv1-1_ja", lang="ja")
        self._item(db, user, "custom card#1", quantity=1)
        self._item(db, user, "sv1-1_ja", quantity=2)

        data = pp.serialize_profile_cards(db, user)

        cards = {card["id"]: card for card in data["cards"]}
        self.assertEqual(set(cards), {"custom card#1", "sv1-1_ja"})
        self.assertTrue(cards["custom card#1"]["is_custom"])
        self.assertEqual(cards["sv1-1_ja"]["lang"], "ja")
        self.assertEqual(cards["sv1-1_ja"]["quantity"], 2)

    def test_all_owned_cards_hide_values_when_flag_off(self):
        db = self._db()
        user = self._user(db, all_owned=True, show_values=False)
        self._set(db)
        self._card(db, "sv1-1_en", price=9.0)
        self._item(db, user, "sv1-1_en", quantity=2)

        data = pp.serialize_profile_cards(db, user)

        self.assertTrue(data["all_owned_cards"])
        self.assertIsNone(data["cards"][0]["market_value"])
        self.assertIsNone(data["total_value"])


try:
    from fastapi import HTTPException
    from api.public import (
        get_public_profile,
        get_public_binder,
        get_public_profile_cards,
        list_public_profiles,
    )
    API_DEPS = True
except ModuleNotFoundError:
    API_DEPS = False


@unittest.skipUnless(API_DEPS, "api deps unavailable")
class PublicApiTests(unittest.TestCase):
    def _db(self, enabled=True):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        if enabled:
            db.add(Setting(key="public_profiles_enabled", value="true"))
            db.commit()
        return db

    def _seed(self, db, **kw):
        return SerializationTests()._seed(db, **kw)

    def _disable_feature(self, db):
        setting = db.query(Setting).filter(Setting.key == "public_profiles_enabled").one()
        setting.value = "false"
        db.commit()

    def _seed_all_owned(self, db, *, all_owned, profile_public=True, active=True):
        helper = ProfileCardsSerializationTests()
        user = helper._user(
            db,
            all_owned=all_owned,
            public=profile_public,
            active=active,
        )
        helper._set(db)
        helper._card(db, "sv1-1_en", number="1", price=5.0)
        helper._card(db, "sv1-2_en", number="2", price=1.0)
        item = helper._item(db, user, "sv1-1_en", quantity=5)
        helper._add(db, helper._binder(db, user, "Public"), "sv1-1_en", quantity=2, item=item)
        helper._item(db, user, "sv1-2_en", quantity=1)  # owned outside binders
        return user

    def test_unknown_handle_404(self):
        db = self._db()
        with self.assertRaises(HTTPException) as ctx:
            get_public_profile("nobody", db=db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_feature_is_disabled_when_setting_is_missing(self):
        db = self._db(enabled=False)
        self._seed(db)
        with self.assertRaises(HTTPException) as ctx:
            get_public_profile("ash", db=db)
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(ctx.exception.headers["Cache-Control"], "no-store")

    def test_private_profile_404(self):
        db = self._db()
        self._seed(db, profile_public=False)
        with self.assertRaises(HTTPException) as ctx:
            get_public_profile("ash", db=db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_public_profile_returns_binders(self):
        db = self._db()
        self._seed(db)
        result = get_public_profile("ash", db=db)
        self.assertEqual(result["handle"], "ash")
        self.assertEqual(len(result["binders"]), 1)

    def test_directory_lists_only_live_public_profiles_with_public_binder_counts(self):
        db = self._db()
        self._seed(db)
        private = User(username="misty", hashed_password="x", role="trainer", is_active=True,
                       public_handle="misty", is_profile_public=False)
        inactive = User(username="brock", hashed_password="x", role="trainer", is_active=False,
                        public_handle="brock", is_profile_public=True)
        db.add_all([private, inactive])
        db.commit()
        result = list_public_profiles(db=db)
        self.assertEqual(result, [{
            "handle": "ash",
            "trainer_name": "ash",
            "avatar_id": None,
            "binder_count": 1,
            "deck_count": 0,
            "wishlist_is_public": False,
        }])

    def test_directory_excludes_public_wishlist_binders(self):
        db = self._db()
        user, _ = self._seed(db)
        db.add(Binder(name="Wishlist", user_id=user.id, binder_type="wishlist", is_public=True))
        db.commit()
        result = list_public_profiles(db=db)
        self.assertEqual(result[0]["binder_count"], 1)

    def test_directory_requires_global_feature_enabled(self):
        for label, enabled in (("missing", False), ("disabled", True)):
            with self.subTest(label):
                db = self._db(enabled=enabled)
                self._seed(db)
                if enabled:
                    self._disable_feature(db)

                with self.assertRaises(HTTPException) as ctx:
                    list_public_profiles(db=db)

                self.assertEqual(ctx.exception.status_code, 404)
                self.assertEqual(ctx.exception.headers["Cache-Control"], "no-store")
                self.assertEqual(ctx.exception.detail, "Profile not found")

    def test_private_binder_404(self):
        db = self._db()
        _, binder = self._seed(db, binder_public=False)
        with self.assertRaises(HTTPException) as ctx:
            get_public_binder("ash", binder.id, db=db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_binder_requires_global_feature_enabled(self):
        for label, enabled in (("missing", False), ("disabled", True)):
            with self.subTest(label):
                db = self._db(enabled=enabled)
                _, binder = self._seed(db)
                if enabled:
                    self._disable_feature(db)

                with self.assertRaises(HTTPException) as ctx:
                    get_public_binder("ash", binder.id, db=db)

                self.assertEqual(ctx.exception.status_code, 404)
                self.assertEqual(ctx.exception.headers["Cache-Control"], "no-store")

    def test_binder_hidden_when_profile_is_private_or_inactive(self):
        for change in ("private", "inactive"):
            with self.subTest(change=change):
                db = self._db()
                user, binder = self._seed(db)  # binder itself is public
                if change == "private":
                    user.is_profile_public = False
                else:
                    user.is_active = False
                db.commit()

                with self.assertRaises(HTTPException) as ctx:
                    get_public_binder("ash", binder.id, db=db)

                self.assertEqual(ctx.exception.status_code, 404)
                self.assertEqual(ctx.exception.headers["Cache-Control"], "no-store")

    def test_public_wishlist_binder_cannot_be_fetched_by_id(self):
        db = self._db()
        user, _ = self._seed(db)
        wishlist = Binder(
            name="Wishlist",
            user_id=user.id,
            binder_type="wishlist",
            is_public=True,
        )
        db.add(wishlist)
        db.commit()

        with self.assertRaises(HTTPException) as ctx:
            get_public_binder("ash", wishlist.id, db=db)

        self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(ctx.exception.headers["Cache-Control"], "no-store")

    def test_profile_hidden_when_private_or_inactive(self):
        for change in ("private", "inactive"):
            with self.subTest(change=change):
                db = self._db()
                user, _ = self._seed(db)
                if change == "private":
                    user.is_profile_public = False
                else:
                    user.is_active = False
                db.commit()

                with self.assertRaises(HTTPException) as ctx:
                    get_public_profile("ash", db=db)

                self.assertEqual(ctx.exception.status_code, 404)
                self.assertEqual(ctx.exception.headers["Cache-Control"], "no-store")

    def test_cross_owner_binder_404(self):
        db = self._db()
        self._seed(db)
        # A public binder id that belongs to a different (nonexistent) handle path
        other = Binder(name="Other", user_id=999, binder_type="collection", is_public=True)
        db.add(other)
        db.commit()
        with self.assertRaises(HTTPException) as ctx:
            get_public_binder("ash", other.id, db=db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_success_sets_short_revalidating_cache(self):
        from fastapi import Response
        db = self._db()
        _, binder = self._seed(db)
        resp = Response()
        get_public_binder("ash", binder.id, db=db, response=resp)
        cc = resp.headers["Cache-Control"]
        self.assertIn("max-age=0", cc)
        self.assertIn("must-revalidate", cc)

    def test_profile_success_sets_revalidating_cache(self):
        from fastapi import Response
        db = self._db()
        self._seed(db)
        resp = Response()
        get_public_profile("ash", db=db, response=resp)
        self.assertEqual(resp.headers["Cache-Control"], "public, max-age=0, must-revalidate")

    def test_not_found_explicitly_disables_caching(self):
        from fastapi import Response
        db = self._db()  # no seed → unknown handle
        resp = Response()
        with self.assertRaises(HTTPException) as ctx:
            get_public_binder("ash", 1, db=db, response=resp)
        self.assertEqual(ctx.exception.headers["Cache-Control"], "no-store")
    def test_profile_cards_unknown_handle_404_no_store(self):
        db = self._db()
        with self.assertRaises(HTTPException) as ctx:
            get_public_profile_cards("nobody", db=db)
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(ctx.exception.headers["Cache-Control"], "no-store")

    def test_profile_cards_feature_disabled_404_no_store(self):
        db = self._db(enabled=False)
        self._seed(db)
        with self.assertRaises(HTTPException) as ctx:
            get_public_profile_cards("ash", db=db)
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(ctx.exception.headers["Cache-Control"], "no-store")

    def test_profile_cards_private_or_inactive_profile_404(self):
        for change in ("private", "inactive"):
            with self.subTest(change=change):
                db = self._db()
                user, _ = self._seed(db)
                if change == "private":
                    user.is_profile_public = False
                else:
                    user.is_active = False
                db.commit()
                with self.assertRaises(HTTPException) as ctx:
                    get_public_profile_cards("ash", db=db)
                self.assertEqual(ctx.exception.status_code, 404)
                self.assertEqual(ctx.exception.headers["Cache-Control"], "no-store")

    def test_profile_cards_success_contract_and_cache(self):
        from fastapi import Response
        db = self._db()
        user, _ = self._seed(db, show_values=True)
        resp = Response()
        result = get_public_profile_cards("ash", db=db, response=resp)

        self.assertEqual(set(result), {
            "handle", "trainer_name", "show_values", "all_owned_cards", "cards",
            "card_count", "unique_card_count", "total_value",
        })
        self.assertEqual(result["handle"], "ash")
        self.assertEqual(result["trainer_name"], "ash")
        self.assertTrue(result["show_values"])
        self.assertEqual(result["cards"][0]["set_id"], "sv1")
        self.assertEqual(result["cards"][0]["quantity"], 2)
        self.assertEqual(result["card_count"], 2)
        self.assertEqual(result["unique_card_count"], 1)
        self.assertEqual(result["total_value"], 10.0)
        cc = resp.headers["Cache-Control"]
        self.assertIn("max-age=0", cc)
        self.assertIn("must-revalidate", cc)

    def test_profile_cards_all_owned_matrix(self):
        for all_owned in (False, True):
            for feature in (False, True):
                for profile_public in (False, True):
                    for active in (False, True):
                        label = (
                            f"all_owned={all_owned} feature={feature} "
                            f"profile={profile_public} active={active}"
                        )
                        with self.subTest(label):
                            db = self._db(enabled=feature)
                            self._seed_all_owned(
                                db,
                                all_owned=all_owned,
                                profile_public=profile_public,
                                active=active,
                            )
                            allowed = feature and profile_public and active
                            if not allowed:
                                with self.assertRaises(HTTPException) as ctx:
                                    get_public_profile_cards("ash", db=db)
                                self.assertEqual(ctx.exception.status_code, 404)
                                self.assertEqual(
                                    ctx.exception.headers["Cache-Control"], "no-store"
                                )
                                continue

                            result = get_public_profile_cards("ash", db=db)
                            self.assertEqual(result["all_owned_cards"], all_owned)
                            expected = (
                                {"sv1-1_en": 5, "sv1-2_en": 1}
                                if all_owned
                                else {"sv1-1_en": 2}
                            )
                            self.assertEqual(
                                {card["id"]: card["quantity"] for card in result["cards"]},
                                expected,
                            )
                            self.assertEqual(result["card_count"], sum(expected.values()))

    def test_profile_cards_revocation_on_subsequent_request(self):
        db = self._db()
        user, _ = self._seed(db)
        self.assertEqual(get_public_profile_cards("ash", db=db)["card_count"], 2)

        user.is_profile_public = False
        db.commit()
        with self.assertRaises(HTTPException) as ctx:
            get_public_profile_cards("ash", db=db)
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(ctx.exception.headers["Cache-Control"], "no-store")

        user.is_profile_public = True
        db.commit()
        self.assertEqual(get_public_profile_cards("ash", db=db)["card_count"], 2)

        setting = db.query(Setting).filter(Setting.key == "public_profiles_enabled").one()
        setting.value = "false"
        db.commit()
        with self.assertRaises(HTTPException) as ctx:
            get_public_profile_cards("ash", db=db)
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(ctx.exception.headers["Cache-Control"], "no-store")

    def test_profile_cards_respond_to_binder_privacy_change(self):
        db = self._db()
        user, first = self._seed(db)
        db.add(Card(id="sv1-2_en", tcg_card_id="sv1-2", name="Two", set_id="sv1",
                    number="2", lang="en", rarity="Common", price_trend=1.0))
        second = Binder(name="Second", user_id=user.id, binder_type="collection", is_public=True)
        db.add(second)
        db.commit()
        db.add(BinderCard(binder_id=second.id, card_id="sv1-2_en", required_quantity=1))
        db.commit()

        self.assertEqual(
            [card["id"] for card in get_public_profile_cards("ash", db=db)["cards"]],
            ["sv1-1_en", "sv1-2_en"],
        )

        second.is_public = False
        db.commit()
        result = get_public_profile_cards("ash", db=db)
        self.assertEqual([card["id"] for card in result["cards"]], ["sv1-1_en"])
        self.assertEqual(result["card_count"], 2)

    def test_profile_cards_privacy_matrix(self):
        for feature in (False, True):
            for profile_public in (False, True):
                for active in (False, True):
                    for binder_public in (False, True):
                        for binder_type in ("collection", "wishlist"):
                            for show_values in (False, True):
                                label = (
                                    f"feature={feature} profile={profile_public} active={active} "
                                    f"binder_public={binder_public} binder_type={binder_type} "
                                    f"show_values={show_values}"
                                )
                                with self.subTest(label):
                                    db = self._db(enabled=feature)
                                    user, binder = self._seed(
                                        db,
                                        profile_public=profile_public,
                                        binder_public=binder_public,
                                        show_values=show_values,
                                    )
                                    user.is_active = active
                                    binder.binder_type = binder_type
                                    db.commit()

                                    allowed = (
                                        feature and profile_public and active
                                    )
                                    content_visible = (
                                        allowed and binder_public and binder_type == "collection"
                                    )
                                    if allowed:
                                        result = get_public_profile_cards("ash", db=db)
                                        self.assertEqual(len(result["cards"]), 1 if content_visible else 0)
                                        self.assertEqual(result["show_values"], show_values)
                                        if not show_values:
                                            self.assertIsNone(result["total_value"])
                                        else:
                                            self.assertEqual(result["total_value"], 10.0 if content_visible else 0.0)
                                    else:
                                        with self.assertRaises(HTTPException) as ctx:
                                            get_public_profile_cards("ash", db=db)
                                        self.assertEqual(ctx.exception.status_code, 404)
                                        self.assertEqual(
                                            ctx.exception.headers["Cache-Control"], "no-store"
                                        )


try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy.pool import SingletonThreadPool
    from database import get_db
    from api.public import router as public_router
    HTTP_CLIENT_DEPS = True
except (ModuleNotFoundError, ImportError):
    HTTP_CLIENT_DEPS = False


@unittest.skipUnless(HTTP_CLIENT_DEPS, "http client deps unavailable")
class PublicProfileCardsHttpTests(unittest.TestCase):
    def _engine(self):
        # A file-backed SQLite database keeps each request's connection inside
        # the TestClient worker thread; StaticPool would hand one DBAPI
        # connection across threads and upset sqlite's thread checks.
        with tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False) as handle:
            path = handle.name
        self.addCleanup(os.unlink, path)
        engine = create_engine(
            f"sqlite:///{path}",
            connect_args={"check_same_thread": False},
            poolclass=SingletonThreadPool,
        )
        self.addCleanup(engine.dispose)
        Base.metadata.create_all(engine)
        return engine

    def _session(self, engine):
        return sessionmaker(bind=engine)()

    def _seed(self, engine, *, enabled=True, show_values=False):
        helper = ProfileCardsSerializationTests()
        db = self._session(engine)
        if enabled:
            db.add(Setting(key="public_profiles_enabled", value="true"))
            db.commit()
        user = helper._user(db, show_values=show_values)
        helper._set(db)
        helper._card(db, "sv1-1_en", price=5.0)
        binder = helper._binder(db, user)
        helper._add(db, binder, "sv1-1_en", quantity=2)
        db.close()

    def _client(self, engine):
        # Collect unclosed sessions from earlier in-memory tests in this thread;
        # letting the TestClient worker thread finalise them trips sqlite's
        # cross-thread guard.
        gc.collect()
        SessionLocal = sessionmaker(bind=engine)
        app = FastAPI()
        app.include_router(public_router, prefix="/api/public")

        def override_get_db():
            db = SessionLocal()
            try:
                yield db
            finally:
                db.close()

        app.dependency_overrides[get_db] = override_get_db
        return TestClient(app)

    def test_http_success_uses_response_model_and_revalidating_cache(self):
        engine = self._engine()
        self._seed(engine, show_values=True)
        client = self._client(engine)

        response = client.get("/api/public/profiles/ash/cards")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.headers["cache-control"],
            "public, max-age=0, must-revalidate",
        )
        data = response.json()
        self.assertEqual(set(data), {
            "handle", "trainer_name", "show_values", "all_owned_cards", "cards",
            "card_count", "unique_card_count", "total_value",
        })
        self.assertEqual(data["cards"][0]["set_id"], "sv1")
        self.assertEqual(data["cards"][0]["quantity"], 2)
        self.assertEqual(data["total_value"], 10.0)
        self.assertNotIn("custom_image_url", data["cards"][0])

    def test_http_not_found_and_revocation_are_no_store(self):
        engine = self._engine()
        self._seed(engine)
        client = self._client(engine)

        missing = client.get("/api/public/profiles/nobody/cards")
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.headers["cache-control"], "no-store")

        self.assertEqual(client.get("/api/public/profiles/ash/cards").status_code, 200)

        db = self._session(engine)
        user = db.query(User).filter(User.public_handle == "ash").one()
        user.is_profile_public = False
        db.commit()
        db.close()

        revoked = client.get("/api/public/profiles/ash/cards")
        self.assertEqual(revoked.status_code, 404)
        self.assertEqual(revoked.headers["cache-control"], "no-store")

        db = self._session(engine)
        user = db.query(User).filter(User.public_handle == "ash").one()
        user.is_profile_public = True
        setting = db.query(Setting).filter(Setting.key == "public_profiles_enabled").one()
        setting.value = "false"
        db.commit()
        db.close()

        feature_off = client.get("/api/public/profiles/ash/cards")
        self.assertEqual(feature_off.status_code, 404)
        self.assertEqual(feature_off.headers["cache-control"], "no-store")


try:
    from api.profile import update_profile, get_profile
    from schemas import ProfileUpdate
    PROFILE_DEPS = True
except ModuleNotFoundError:
    PROFILE_DEPS = False


@unittest.skipUnless(PROFILE_DEPS, "profile api deps unavailable")
class ProfileControlTests(unittest.TestCase):
    def _db(self, enabled=True):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        if enabled:
            db.add(Setting(key="public_profiles_enabled", value="true"))
            db.commit()
        return db

    def _user(self, db, username="ash"):
        u = User(username=username, hashed_password="x", role="trainer", is_active=True)
        db.add(u)
        db.commit()
        db.refresh(u)
        return u

    def test_publish_uses_trainer_name_handle(self):
        db = self._db()
        u = self._user(db, "Ash Ketchum")
        result = update_profile(ProfileUpdate(is_profile_public=True), db=db, current_user=u)
        self.assertEqual(result["public_handle"], "ash-ketchum")
        self.assertEqual(result["trainer_name"], "Ash Ketchum")
        self.assertTrue(result["is_profile_public"])

    def test_invalid_trainer_name_422(self):
        db = self._db()
        u = self._user(db, "🔥")
        with self.assertRaises(HTTPException) as ctx:
            update_profile(ProfileUpdate(is_profile_public=True), db=db, current_user=u)
        self.assertEqual(ctx.exception.status_code, 422)
        db.refresh(u)
        self.assertFalse(u.is_profile_public)
        self.assertIsNone(u.public_handle)

    def test_duplicate_derived_handle_409(self):
        db = self._db()
        taken = self._user(db, "Misty Star")
        update_profile(ProfileUpdate(is_profile_public=True), db=db, current_user=taken)
        me = self._user(db, "Misty-Star")
        with self.assertRaises(HTTPException) as ctx:
            update_profile(ProfileUpdate(is_profile_public=True), db=db, current_user=me)
        self.assertEqual(ctx.exception.status_code, 409)
        db.refresh(me)
        self.assertFalse(me.is_profile_public)
        self.assertIsNone(me.public_handle)

    def test_concurrent_unique_constraint_is_returned_as_409(self):
        from sqlalchemy.exc import IntegrityError
        from unittest.mock import patch
        db = self._db()
        u = self._user(db)
        with (
            patch.object(pp, "is_handle_available", return_value=True),
            patch.object(
                db,
                "commit",
                side_effect=IntegrityError("insert", {}, Exception("duplicate public_handle")),
            ),
            patch.object(db, "rollback") as rollback,
        ):
            with self.assertRaises(HTTPException) as ctx:
                update_profile(ProfileUpdate(is_profile_public=True), db=db, current_user=u)
        self.assertEqual(ctx.exception.status_code, 409)
        rollback.assert_called_once()

    def test_unrelated_integrity_error_is_not_mislabeled_as_handle_conflict(self):
        from sqlalchemy.exc import IntegrityError
        from unittest.mock import patch
        db = self._db()
        u = self._user(db)
        failure = IntegrityError("insert", {}, Exception("unrelated check constraint"))
        with (
            patch.object(pp, "is_handle_available", return_value=True),
            patch.object(db, "commit", side_effect=failure),
            patch.object(db, "rollback") as rollback,
        ):
            with self.assertRaises(IntegrityError):
                update_profile(ProfileUpdate(is_profile_public=True), db=db, current_user=u)
        rollback.assert_called_once()

    def test_disabling_profile_releases_stored_handle(self):
        db = self._db()
        u = self._user(db)
        update_profile(ProfileUpdate(is_profile_public=True), db=db, current_user=u)
        result = update_profile(ProfileUpdate(is_profile_public=False), db=db, current_user=u)
        db.refresh(u)
        self.assertIsNone(u.public_handle)
        self.assertEqual(result["public_handle"], "ash")
        self.assertFalse(result["is_profile_public"])

    def test_profile_controls_are_read_only_while_feature_disabled(self):
        db = self._db(enabled=False)
        u = self._user(db)
        result = get_profile(db=db, current_user=u)
        self.assertFalse(result["feature_enabled"])
        with self.assertRaises(HTTPException) as ctx:
            update_profile(ProfileUpdate(is_profile_public=True), db=db, current_user=u)
        self.assertEqual(ctx.exception.status_code, 403)

    def test_get_profile_returns_current_user_values(self):
        db = self._db()
        u = self._user(db, "Ash K")
        update_profile(ProfileUpdate(is_profile_public=True, public_show_values=True),
                       db=db, current_user=u)
        result = get_profile(db=db, current_user=u)
        self.assertEqual(result["public_handle"], "ash-k")
        self.assertEqual(result["trainer_name"], "Ash K")
        self.assertIsNone(result["public_handle_error"])
        self.assertTrue(result["is_profile_public"])
        self.assertTrue(result["public_show_values"])
        self.assertEqual(result["wishlist_visibility"], "private")

    def test_wishlist_visibility_is_explicit_and_validated(self):
        from pydantic import ValidationError

        db = self._db()
        u = self._user(db)
        result = update_profile(
            ProfileUpdate(wishlist_visibility="trade_matches"),
            db=db,
            current_user=u,
        )
        self.assertEqual(result["wishlist_visibility"], "trade_matches")
        with self.assertRaises(ValidationError):
            ProfileUpdate(wishlist_visibility="everyone")

    def test_get_profile_explains_invalid_trainer_name(self):
        db = self._db()
        u = self._user(db, "🔥")
        result = get_profile(db=db, current_user=u)
        self.assertIsNone(result["public_handle"])
        self.assertIn("Trainer name", result["public_handle_error"])

    def test_default_new_binders_defaults_false(self):
        db = self._db()
        u = self._user(db)
        result = get_profile(db=db, current_user=u)
        self.assertFalse(result["public_default_new_binders"])

    def test_default_new_binders_persists_while_profile_switched_off(self):
        db = self._db()
        u = self._user(db, "Ash K")
        update_profile(
            ProfileUpdate(public_default_new_binders=True),
            db=db,
            current_user=u,
        )
        update_profile(
            ProfileUpdate(is_profile_public=False),
            db=db,
            current_user=u,
        )

        db.refresh(u)
        self.assertTrue(u.public_default_new_binders)
        self.assertFalse(u.is_profile_public)
        result = get_profile(db=db, current_user=u)
        self.assertTrue(result["public_default_new_binders"])
        self.assertFalse(result["is_profile_public"])

    def test_default_new_binders_is_rejected_while_feature_disabled(self):
        db = self._db(enabled=False)
        u = self._user(db)
        with self.assertRaises(HTTPException) as ctx:
            update_profile(
                ProfileUpdate(public_default_new_binders=True),
                db=db,
                current_user=u,
            )
        self.assertEqual(ctx.exception.status_code, 403)
        db.refresh(u)
        self.assertFalse(u.public_default_new_binders)

    def test_show_all_owned_cards_defaults_false_and_counts_private_collection_binders(self):
        db = self._db()
        u = self._user(db)
        other = self._user(db, "misty")
        db.add_all([
            Binder(name="Private one", user_id=u.id, binder_type="collection", is_public=False),
            Binder(name="Private two", user_id=u.id, binder_type="collection", is_public=False),
            Binder(name="Public", user_id=u.id, binder_type="collection", is_public=True),
            Binder(name="Wishlist", user_id=u.id, binder_type="wishlist", is_public=False),
            Binder(name="Other private", user_id=other.id, binder_type="collection", is_public=False),
        ])
        db.commit()

        result = get_profile(db=db, current_user=u)

        self.assertFalse(result["public_show_all_owned_cards"])
        self.assertEqual(result["private_collection_binder_count"], 2)

    def test_show_all_owned_cards_persists_while_profile_switched_off(self):
        db = self._db()
        u = self._user(db, "Ash K")
        update_profile(
            ProfileUpdate(public_show_all_owned_cards=True),
            db=db,
            current_user=u,
        )
        update_profile(
            ProfileUpdate(is_profile_public=False),
            db=db,
            current_user=u,
        )

        db.refresh(u)
        self.assertTrue(u.public_show_all_owned_cards)
        self.assertFalse(u.is_profile_public)
        result = get_profile(db=db, current_user=u)
        self.assertTrue(result["public_show_all_owned_cards"])
        self.assertFalse(result["is_profile_public"])

    def test_show_all_owned_cards_is_rejected_while_feature_disabled(self):
        db = self._db(enabled=False)
        u = self._user(db)
        with self.assertRaises(HTTPException) as ctx:
            update_profile(
                ProfileUpdate(public_show_all_owned_cards=True),
                db=db,
                current_user=u,
            )
        self.assertEqual(ctx.exception.status_code, 403)
        db.refresh(u)
        self.assertFalse(u.public_show_all_owned_cards)


@unittest.skipUnless(SERVICE_DEPS, "service deps unavailable")
class PublicHandleMigrationTests(unittest.TestCase):
    def test_migration_replaces_legacy_handles_and_disables_collisions(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        first = User(username="Ash K", hashed_password="x", role="trainer", is_active=True,
                     public_handle="custom-one", is_profile_public=True)
        collision = User(username="Ash-K", hashed_password="x", role="trainer", is_active=True,
                         public_handle="custom-two", is_profile_public=True)
        private = User(username="Misty", hashed_password="x", role="trainer", is_active=True,
                       public_handle="legacy", is_profile_public=False)
        db.add_all([first, collision, private])
        db.commit()
        result = migrate_public_profile_handles(db)
        db.refresh(first)
        db.refresh(collision)
        db.refresh(private)
        self.assertEqual(result, {"migrated": 1, "disabled": 1})
        self.assertEqual(first.public_handle, "ash-k")
        self.assertFalse(collision.is_profile_public)
        self.assertIsNone(collision.public_handle)
        self.assertIsNone(private.public_handle)

        repeat = migrate_public_profile_handles(db)
        db.refresh(first)
        self.assertEqual(repeat, {"migrated": 0, "disabled": 0})
        self.assertEqual(first.public_handle, "ash-k")


try:
    from api.binders import (
        add_owned_set_to_auto_binder,
        convert_wishlist_binder_to_collection,
        create_binder,
        publish_all_collection_binders,
        update_binder,
    )
    from schemas import BinderCreate, BinderUpdate
    BINDER_DEPS = True
except ModuleNotFoundError:
    BINDER_DEPS = False


@unittest.skipUnless(BINDER_DEPS, "binder api deps unavailable")
class BinderPublicToggleTests(unittest.TestCase):
    def _db(self, enabled=True):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        if enabled:
            db.add(Setting(key="public_profiles_enabled", value="true"))
            db.commit()
        return db

    def test_update_binder_sets_is_public(self):
        db = self._db()
        user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        db.add(user)
        db.commit()
        db.refresh(user)
        binder = Binder(name="B", user_id=user.id, binder_type="collection")
        db.add(binder)
        db.commit()
        resp = update_binder(binder.id, BinderUpdate(is_public=True), db=db, current_user=user)
        self.assertTrue(resp.is_public)

    def test_public_toggle_is_rejected_while_feature_disabled(self):
        db = self._db(enabled=False)
        user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        db.add(user)
        db.commit()
        binder = Binder(name="B", user_id=user.id, binder_type="collection", is_public=True)
        db.add(binder)
        db.commit()
        with self.assertRaises(HTTPException) as ctx:
            update_binder(binder.id, BinderUpdate(is_public=False), db=db, current_user=user)
        self.assertEqual(ctx.exception.status_code, 403)
        db.refresh(binder)
        self.assertTrue(binder.is_public)

    def test_public_toggle_requires_a_boolean(self):
        db = self._db()
        user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        db.add(user)
        db.commit()
        binder = Binder(name="B", user_id=user.id, binder_type="collection")
        db.add(binder)
        db.commit()
        with self.assertRaises(HTTPException) as ctx:
            update_binder(binder.id, BinderUpdate(is_public=None), db=db, current_user=user)
        self.assertEqual(ctx.exception.status_code, 422)

    def test_wishlist_binder_cannot_be_published(self):
        db = self._db()
        user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        db.add(user)
        db.commit()
        binder = Binder(name="Wishlist", user_id=user.id, binder_type="wishlist")
        db.add(binder)
        db.commit()
        with self.assertRaises(HTTPException) as ctx:
            update_binder(binder.id, BinderUpdate(is_public=True), db=db, current_user=user)
        self.assertEqual(ctx.exception.status_code, 422)
        db.refresh(binder)
        self.assertFalse(binder.is_public)

    def test_public_collection_becomes_private_when_changed_to_wishlist(self):
        db = self._db()
        user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        db.add(user)
        db.commit()
        binder = Binder(
            name="Collection", user_id=user.id, binder_type="collection", is_public=True
        )
        db.add(binder)
        db.commit()
        response = update_binder(
            binder.id, BinderUpdate(binder_type="wishlist"), db=db, current_user=user
        )
        self.assertEqual(response.binder_type, "wishlist")
        self.assertFalse(response.is_public)

    def test_flagged_wishlist_becomes_private_when_changed_to_collection(self):
        db = self._db()
        user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        db.add(user)
        db.commit()
        binder = Binder(
            name="Legacy", user_id=user.id, binder_type="wishlist", is_public=True
        )
        db.add(binder)
        db.commit()
        response = update_binder(
            binder.id, BinderUpdate(binder_type="collection"), db=db, current_user=user
        )
        self.assertEqual(response.binder_type, "collection")
        self.assertFalse(response.is_public)

    def test_combined_wishlist_conversion_and_publication_is_rejected(self):
        db = self._db()
        user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        db.add(user)
        db.commit()
        binder = Binder(name="Collection", user_id=user.id, binder_type="collection")
        db.add(binder)
        db.commit()
        with self.assertRaises(HTTPException) as ctx:
            update_binder(
                binder.id,
                BinderUpdate(binder_type="wishlist", is_public=True),
                db=db,
                current_user=user,
            )
        self.assertEqual(ctx.exception.status_code, 422)
        db.refresh(binder)
        self.assertEqual(binder.binder_type, "collection")
        self.assertFalse(binder.is_public)

    def test_unrelated_binder_edit_still_works_while_feature_disabled(self):
        db = self._db(enabled=False)
        user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        db.add(user)
        db.commit()
        binder = Binder(name="Before", user_id=user.id, binder_type="collection", is_public=True)
        db.add(binder)
        db.commit()
        response = update_binder(binder.id, BinderUpdate(name="After"), db=db, current_user=user)
        self.assertEqual(response.name, "After")
        self.assertTrue(response.is_public)


@unittest.skipUnless(BINDER_DEPS, "binder api deps unavailable")
class PublicDefaultNewBinderTests(unittest.TestCase):
    def _db(self, enabled=True):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        if enabled:
            db.add(Setting(key="public_profiles_enabled", value="true"))
            db.commit()
        return db

    def _user(self, db, *, default=False, public=True):
        user = User(
            username="ash",
            hashed_password="x",
            role="trainer",
            is_active=True,
            public_handle="ash" if public else None,
            is_profile_public=public,
            public_default_new_binders=default,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return user

    def _seed_owned_set(self, db, user):
        db.add_all([
            Set(id="sv1_en", tcg_set_id="sv1", name="Scarlet & Violet", lang="en", total=1),
            Card(
                id="sv1-1_en",
                tcg_card_id="sv1-1",
                name="Sprigatito",
                set_id="sv1",
                number="1",
                lang="en",
                rarity="Common",
            ),
        ])
        db.commit()
        db.add(CollectionItem(
            card_id="sv1-1_en",
            user_id=user.id,
            quantity=1,
            variant="Normal",
            condition="NM",
        ))
        db.commit()

    def test_create_binder_default_matrix(self):
        for feature in (False, True):
            for profile_public in (False, True):
                for default in (False, True):
                    for binder_type in ("collection", "wishlist"):
                        label = (
                            f"feature={feature} profile={profile_public} "
                            f"default={default} type={binder_type}"
                        )
                        with self.subTest(label):
                            db = self._db(enabled=feature)
                            user = self._user(db, default=default, public=profile_public)
                            response = create_binder(
                                BinderCreate(name="Binder", binder_type=binder_type),
                                current_user=user,
                                db=db,
                            )
                            expected = (
                                feature and profile_public and default
                                and binder_type == "collection"
                            )
                            self.assertEqual(bool(response.is_public), expected)
                            row = db.query(Binder).filter(Binder.id == response.id).one()
                            self.assertEqual(bool(row.is_public), expected)

    def test_auto_owned_set_default_matrix(self):
        for feature in (False, True):
            for profile_public in (False, True):
                for default in (False, True):
                    label = (
                        f"feature={feature} profile={profile_public} default={default}"
                    )
                    with self.subTest(label):
                        db = self._db(enabled=feature)
                        user = self._user(db, default=default, public=profile_public)
                        self._seed_owned_set(db, user)
                        result = add_owned_set_to_auto_binder(
                            "sv1_en", current_user=user, db=db
                        )
                        self.assertTrue(result["binder_created"])
                        binder = db.query(Binder).filter(
                            Binder.id == result["binder_id"]
                        ).one()
                        expected = feature and profile_public and default
                        self.assertEqual(bool(binder.is_public), expected)

    def test_existing_private_binder_stays_private(self):
        db = self._db()
        user = self._user(db, default=True, public=True)
        binder = Binder(
            name="Existing",
            user_id=user.id,
            binder_type="collection",
            is_public=False,
        )
        db.add(binder)
        db.commit()

        update_binder(
            binder.id,
            BinderUpdate(name="Renamed"),
            db=db,
            current_user=user,
        )

        db.refresh(binder)
        self.assertFalse(binder.is_public)

    def test_binder_created_while_profile_off_stays_private_later(self):
        db = self._db()
        user = self._user(db, default=True, public=False)
        created = create_binder(
            BinderCreate(name="Binder", binder_type="collection"),
            current_user=user,
            db=db,
        )
        self.assertFalse(created.is_public)

        user.is_profile_public = True
        db.commit()

        row = db.query(Binder).filter(Binder.id == created.id).one()
        self.assertFalse(row.is_public)

    def test_profile_preference_applies_to_next_create_binder(self):
        db = self._db()
        user = self._user(db, default=False, public=True)
        update_profile(
            ProfileUpdate(public_default_new_binders=True),
            db=db,
            current_user=user,
        )

        response = create_binder(
            BinderCreate(name="Binder", binder_type="collection"),
            current_user=user,
            db=db,
        )

        self.assertTrue(response.is_public)

    def test_existing_auto_binder_keeps_its_private_state(self):
        db = self._db()
        user = self._user(db, default=True, public=True)
        self._seed_owned_set(db, user)
        binder = Binder(
            name="Existing owned",
            user_id=user.id,
            binder_type="collection",
            is_public=False,
            auto_owned_set_id="sv1_en",
        )
        db.add(binder)
        db.commit()

        result = add_owned_set_to_auto_binder("sv1_en", current_user=user, db=db)

        self.assertFalse(result["binder_created"])
        db.refresh(binder)
        self.assertFalse(binder.is_public)

    def test_manual_private_override_persists(self):
        db = self._db()
        user = self._user(db, default=True, public=True)
        created = create_binder(
            BinderCreate(name="Binder", binder_type="collection"),
            current_user=user,
            db=db,
        )
        self.assertTrue(created.is_public)

        update_binder(
            created.id,
            BinderUpdate(is_public=False),
            db=db,
            current_user=user,
        )
        update_binder(
            created.id,
            BinderUpdate(name="Renamed"),
            db=db,
            current_user=user,
        )

        row = db.query(Binder).filter(Binder.id == created.id).one()
        self.assertFalse(row.is_public)

    def test_conversion_to_collection_never_republishes(self):
        db = self._db()
        user = self._user(db, default=True, public=True)
        binder = Binder(
            name="Wishlist",
            user_id=user.id,
            binder_type="wishlist",
            is_public=False,
        )
        db.add(binder)
        db.commit()

        response = update_binder(
            binder.id,
            BinderUpdate(binder_type="collection", is_public=True),
            db=db,
            current_user=user,
        )

        self.assertFalse(response.is_public)
        db.refresh(binder)
        self.assertFalse(binder.is_public)

    def test_convert_wishlist_endpoint_never_republishes(self):
        db = self._db()
        user = self._user(db, default=True, public=True)
        self._seed_owned_set(db, user)
        binder = Binder(
            name="Wishlist",
            user_id=user.id,
            binder_type="wishlist",
            is_public=False,
        )
        db.add(binder)
        db.commit()
        db.add(BinderCard(
            binder_id=binder.id,
            card_id="sv1-1_en",
            required_quantity=1,
        ))
        db.commit()

        convert_wishlist_binder_to_collection(
            binder.id, current_user=user, db=db
        )

        db.refresh(binder)
        self.assertEqual(binder.binder_type, "collection")
        self.assertFalse(binder.is_public)
@unittest.skipUnless(BINDER_DEPS, "binder api deps unavailable")
class PublishAllCollectionTests(unittest.TestCase):
    def _db(self, enabled=True):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        if enabled:
            db.add(Setting(key="public_profiles_enabled", value="true"))
            db.commit()
        return db

    def _user(self, db, username="ash", *, public=False):
        user = User(
            username=username,
            hashed_password="x",
            role="trainer",
            is_active=True,
            public_handle=("ash" if username == "ash" else None),
            is_profile_public=public,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return user

    def test_publishes_only_owners_private_collection_binders(self):
        db = self._db()
        user = self._user(db)
        other = self._user(db, "misty")
        private_one = Binder(name="Private one", user_id=user.id, binder_type="collection", is_public=False)
        private_two = Binder(name="Private two", user_id=user.id, binder_type="collection", is_public=False)
        already_public = Binder(name="Public", user_id=user.id, binder_type="collection", is_public=True)
        wishlist = Binder(name="Wishlist", user_id=user.id, binder_type="wishlist", is_public=False)
        other_private = Binder(name="Other private", user_id=other.id, binder_type="collection", is_public=False)
        db.add_all([private_one, private_two, already_public, wishlist, other_private])
        db.commit()

        result = publish_all_collection_binders(current_user=user, db=db)

        self.assertEqual(result, {"published": 2})
        for binder in (private_one, private_two, already_public):
            db.refresh(binder)
            self.assertTrue(binder.is_public)
        for binder in (wishlist, other_private):
            db.refresh(binder)
            self.assertFalse(binder.is_public)

    def test_requires_global_feature_enabled(self):
        db = self._db(enabled=False)
        user = self._user(db)
        binder = Binder(name="Private", user_id=user.id, binder_type="collection", is_public=False)
        db.add(binder)
        db.commit()

        with self.assertRaises(HTTPException) as ctx:
            publish_all_collection_binders(current_user=user, db=db)

        self.assertEqual(ctx.exception.status_code, 403)
        db.refresh(binder)
        self.assertFalse(binder.is_public)

    def test_does_not_require_public_profile(self):
        db = self._db()
        user = self._user(db, public=False)
        binder = Binder(name="Private", user_id=user.id, binder_type="collection", is_public=False)
        db.add(binder)
        db.commit()

        result = publish_all_collection_binders(current_user=user, db=db)

        self.assertEqual(result, {"published": 1})
        db.refresh(binder)
        self.assertTrue(binder.is_public)


try:
    from api.social import _load_user_stats
    SOCIAL_DEPS = True
except ModuleNotFoundError:
    SOCIAL_DEPS = False


@unittest.skipUnless(SOCIAL_DEPS, "social deps unavailable")
class LeaderboardHandleTests(unittest.TestCase):
    def test_stats_use_combined_portfolio_valuation(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        user = User(username="brock", hashed_password="x", role="trainer", is_active=True)
        db.add(user)
        db.commit()
        db.add(ProductPurchase(
            product_name="Booster Box",
            product_type="Display",
            purchase_price=50,
            current_value=70,
            purchase_date=datetime.date(2026, 8, 8),
            user_id=user.id,
        ))
        db.commit()

        stats = _load_user_stats(db, user_ids=[user.id])

        self.assertEqual(stats[user.id]["total_value"], 70)
        self.assertEqual(stats[user.id]["total_invested"], 50)
        self.assertEqual(stats[user.id]["pnl"], 20)
        self.assertEqual(stats[user.id]["pnl_pct"], 40)

    def test_row_includes_public_handle(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        u = User(username="ash", hashed_password="x", role="trainer", is_active=True,
                 public_handle="ash", is_profile_public=True)
        db.add_all([u, Setting(key="public_profiles_enabled", value="true")])
        db.commit()
        stats = _load_user_stats(db)
        self.assertIn(u.id, stats)
        self.assertEqual(stats[u.id]["public_handle"], "ash")

    def test_row_hides_handle_when_profile_not_public(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        u = User(username="ghost", hashed_password="x", role="trainer", is_active=True,
                 public_handle="ghost", is_profile_public=False)
        db.add_all([u, Setting(key="public_profiles_enabled", value="true")])
        db.commit()
        stats = _load_user_stats(db)
        self.assertIn(u.id, stats)
        self.assertIsNone(stats[u.id]["public_handle"])

    def test_row_hides_handle_when_feature_disabled(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        u = User(username="ash", hashed_password="x", role="trainer", is_active=True,
                 public_handle="ash", is_profile_public=True)
        db.add(u)
        db.commit()
        self.assertIsNone(_load_user_stats(db)[u.id]["public_handle"])


try:
    from api.settings import _get_user_settings, set_setting, update_settings
    SETTINGS_DEPS = True
except ModuleNotFoundError:
    SETTINGS_DEPS = False


@unittest.skipUnless(SETTINGS_DEPS, "settings api deps unavailable")
class PublicProfilesGlobalSettingTests(unittest.TestCase):
    def _db(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine)()

    def _user(self, db, username, role):
        user = User(username=username, hashed_password="x", role=role, is_active=True)
        db.add(user)
        db.commit()
        db.refresh(user)
        return user

    def test_global_feature_defaults_disabled(self):
        db = self._db()
        admin = self._user(db, "admin-user", "admin")
        self.assertEqual(_get_user_settings(db, admin.id)["public_profiles_enabled"], "false")

    def test_admin_can_enable_global_feature(self):
        db = self._db()
        admin = self._user(db, "admin-user", "admin")
        result = set_setting(
            "public_profiles_enabled", {"value": "true"}, db=db, current_user=admin
        )
        self.assertEqual(result["value"], "true")
        self.assertEqual(_get_user_settings(db, admin.id)["public_profiles_enabled"], "true")

    def test_trainer_cannot_change_global_feature(self):
        db = self._db()
        trainer = self._user(db, "trainer-user", "trainer")
        with self.assertRaises(HTTPException) as ctx:
            set_setting(
                "public_profiles_enabled", {"value": "true"}, db=db, current_user=trainer
            )
        self.assertEqual(ctx.exception.status_code, 403)

    def test_trainer_cannot_change_global_feature_through_bulk_settings(self):
        db = self._db()
        trainer = self._user(db, "trainer-user", "trainer")
        with self.assertRaises(HTTPException) as ctx:
            update_settings(
                {"public_profiles_enabled": "true"}, db=db, current_user=trainer
            )
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertEqual(_get_user_settings(db, trainer.id)["public_profiles_enabled"], "false")
