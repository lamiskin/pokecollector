"""Physical-copy integrity and API regressions, without external services."""
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import create_engine, event, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from api.binder_layouts import get_binder_layout, move_binder_copy, update_binder_layout, undo_binder_layout
from api.binders import (
    convert_collection_binder_to_wishlist, delete_binder, remove_binder_entry,
    remove_card_from_binder, switch_binder_entry_card, update_binder_entry,
)
from api.collection import remove_from_collection, update_collection_item
from api.public import get_public_binder_layout, get_public_card_locations
from database import Base
from models import Binder, BinderCard, BinderPlacement, Card, CollectionCardPhoto, CollectionItem, User, Setting
from schemas import BinderCardUpdate, BinderCardSwitch, BinderLayoutPreview, BinderLayoutUpdate, BinderLayoutUndo, BinderPlacementMove, CollectionItemUpdate
from services.binder_layout_schema import migrate_binder_layout_schema
from services.binder_layouts import card_locations, layout_state, preview_layout, require_unplaced
from services.card_list_removal import remove_card_list_entries


class BinderLayoutTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        @event.listens_for(self.engine, "connect")
        def foreign_keys(conn, _record):
            conn.execute("PRAGMA foreign_keys=ON")
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine)()
        self.user = User(username="binder-owner", hashed_password="x", is_active=True,
                         is_profile_public=True, public_handle="binder-owner")
        self.other = User(username="other-owner", hashed_password="x", is_active=True)
        self.a = Card(id="example-1_en", name="Pikachu", lang="en", playable_fingerprint="same", images_small="https://example.com/card.png")
        self.b = Card(id="example-2_en", name="Raichu", lang="en", playable_fingerprint="same")
        self.db.add_all([self.user, self.other, self.a, self.b])
        self.db.flush()
        self.binder = Binder(name="Example Binder", user_id=self.user.id, binder_type="collection", is_public=True)
        self.item = CollectionItem(user_id=self.user.id, card_id=self.a.id, quantity=3, variant="Normal", condition="NM")
        self.second_item = CollectionItem(user_id=self.user.id, card_id=self.b.id, quantity=2, variant="Holo", condition="LP")
        self.db.add_all([self.binder, self.item, self.second_item])
        self.db.flush()
        self.entry = BinderCard(binder_id=self.binder.id, card_id=self.a.id, collection_item_id=self.item.id, required_quantity=3)
        self.second = BinderCard(binder_id=self.binder.id, card_id=self.b.id, collection_item_id=self.second_item.id, required_quantity=2)
        self.db.add_all([self.entry, self.second, Setting(key="public_profiles_enabled", value="true")])
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def state(self):
        return get_binder_layout(self.binder.id, current_user=self.user, db=self.db)

    def configure(self, pages=2, columns=3, confirmed=None, revision=None, first_page_single=False):
        return update_binder_layout(self.binder.id, BinderLayoutUpdate(
            page_count=pages, columns=columns, first_page_single=first_page_single,
            expected_revision=revision or self.state()["revision"],
            confirmed_unplace_ids=confirmed or [],
        ), current_user=self.user, db=self.db)

    def move(self, entry=None, source=None, page=1, slot=1, confirm=False, revision=None):
        return move_binder_copy(self.binder.id, BinderPlacementMove(
            binder_card_id=(entry or self.entry).id, placement_id=source, page=page, slot=slot,
            confirm_occupied=confirm, expected_revision=revision or self.state()["revision"],
        ), current_user=self.user, db=self.db)

    def undo(self, revision=None):
        return undo_binder_layout(self.binder.id, BinderLayoutUndo(expected_revision=revision or self.state()["revision"]),
                                 current_user=self.user, db=self.db)

    def assert_conflict(self, operation, status=409):
        with self.assertRaises(HTTPException) as caught:
            operation()
        self.assertEqual(caught.exception.status_code, status)
        self.db.rollback()

    def test_enabling_never_infers_gallery_order_or_changes_allocations(self):
        state = self.configure(20)
        self.assertEqual(state["layout"], {"page_count": 20, "rows": 3, "columns": 3, "first_page_single": False})
        self.assertEqual((state["placed_count"], state["unplaced_count"]), (0, 5))
        self.assertEqual(self.item.quantity, 3)
        self.assertEqual(self.entry.required_quantity, 3)

    def test_three_duplicates_two_pages_tray_search_swap_and_undo(self):
        self.configure()
        self.move(slot=7)
        state = self.move(page=2, slot=3)
        placements = state["placements"]
        locations = card_locations(self.db, self.user.id, self.a.id)["locations"]
        self.assertEqual([(r["page"], r["slot"], r["quantity"]) for r in locations], [(1, 7, 1), (2, 3, 1), (None, None, 1)])
        state = self.move(entry=self.second, slot=1)
        before = state["placements"]
        self.assert_conflict(lambda: self.move(source=placements[0]["id"], slot=1))
        self.assertEqual(self.state()["placements"], before)
        swapped = self.move(source=placements[0]["id"], slot=1, confirm=True)
        self.assertEqual(next(p["slot"] for p in swapped["placements"] if p["binder_card_id"] == self.second.id), 7)
        restored = self.undo()
        self.assertEqual(restored["placements"], before)
        self.assertFalse(restored["can_undo"])
        self.assertEqual(self.item.quantity, 3)

    def test_tray_replace_displaces_exactly_one_and_undo_restores_identity(self):
        self.configure()
        before = self.move()["placements"]
        result = self.move(entry=self.second, confirm=True)
        self.assertEqual(result["placed_count"], 1)
        self.assertEqual(next(e["unplaced_quantity"] for e in result["entries"] if e["binder_card_id"] == self.entry.id), 3)
        self.assertEqual(self.undo()["placements"], before)

    def test_return_to_tray_preserves_membership_and_copy_count(self):
        self.configure()
        p = self.move()["placements"][0]
        state = self.move(source=p["id"], page=None, slot=None)
        self.assertEqual((state["placed_count"], state["unplaced_count"]), (0, 5))
        self.assertIsNotNone(self.db.get(BinderCard, self.entry.id))
        self.assertEqual(self.undo()["placements"], [p])

    def test_outside_bounds_and_exhausted_tray_leave_original_state(self):
        self.configure(1)
        self.assert_conflict(lambda: self.move(page=2), 422)
        self.assert_conflict(lambda: self.move(slot=10), 422)
        for slot in range(1, 4):
            self.move(slot=slot)
        before = self.state()
        self.assert_conflict(lambda: self.move(slot=4))
        self.assertEqual(self.state(), before)

    def test_four_column_layout_has_twelve_stable_slots(self):
        self.configure(2, columns=4)
        self.move(slot=12)
        self.assert_conflict(lambda: self.move(page=3), 422)
        self.assertEqual(self.state()["placements"][0]["slot"], 12)

    def test_stale_move_and_undo_cannot_overwrite_intervening_change(self):
        self.configure()
        revision = self.state()["revision"]
        state = self.move()
        self.assert_conflict(lambda: self.move(slot=2, revision=revision))
        self.move(slot=2)
        self.assert_conflict(lambda: self.undo(revision=state["revision"]))
        self.assertEqual(self.state()["placed_count"], 2)

    def test_gallery_membership_change_invalidates_undo(self):
        self.configure()
        revision = self.move()["revision"]
        update_binder_entry(self.binder.id, self.entry.id, BinderCardUpdate(required_quantity=2), current_user=self.user, db=self.db)
        self.assertFalse(self.state()["can_undo"])
        self.assert_conflict(lambda: self.undo(revision=revision))

    def test_growth_preserves_locations_shrink_requires_exact_preview(self):
        self.configure(3)
        self.move(page=3, slot=8)
        original = self.state()["placements"]
        self.configure(4)
        self.assertEqual(self.state()["placements"], original)
        preview = preview_layout(self.db, self.binder, BinderLayoutPreview(page_count=2))
        self.assertEqual([p["id"] for p in preview["affected"]], [original[0]["id"]])
        self.assert_conflict(lambda: self.configure(2))
        self.configure(2, confirmed=[original[0]["id"]])
        self.assertEqual(self.state()["placed_count"], 0)
        self.assertEqual(self.undo()["placements"], original)

    def test_geometry_change_returns_all_copies_not_reinterprets_slots(self):
        self.configure()
        p = self.move(slot=1)["placements"][0]
        preview = preview_layout(self.db, self.binder, BinderLayoutPreview(page_count=2, columns=4))
        self.assertEqual(len(preview["affected"]), 1)
        self.assert_conflict(lambda: self.configure(columns=4))
        self.assertEqual(self.configure(columns=4, confirmed=[p["id"]])["placed_count"], 0)

    def test_disable_requires_preview_and_undo_restores_layout(self):
        self.configure()
        p = self.move()["placements"][0]
        self.assert_conflict(lambda: self.configure(None))
        result = self.configure(None, confirmed=[p["id"]])
        self.assertIsNone(result["layout"])
        self.assertEqual(result["unplaced_count"], 5)
        self.assertEqual(self.undo()["placements"], [p])

    def test_owner_isolation_and_planned_lists_and_decks_unchanged(self):
        self.assert_conflict(lambda: get_binder_layout(self.binder.id, current_user=self.other, db=self.db), 404)
        for kind in ("wishlist", "deck", "physical_deck"):
            binder = Binder(name=kind, binder_type=kind, user_id=self.user.id)
            self.db.add(binder)
            self.db.commit()
            self.assert_conflict(lambda: get_binder_layout(binder.id, current_user=self.user, db=self.db))

    def test_legacy_unresolved_entries_visible_but_never_invent_owned_links(self):
        self.entry.collection_item_id = None
        self.db.commit()
        state = self.configure()
        row = next(e for e in state["entries"] if e["binder_card_id"] == self.entry.id)
        self.assertTrue(row["unresolved"])
        self.assertIsNone(row["collection_item_id"])
        self.assert_conflict(lambda: self.move())

    def test_foreign_inventory_link_never_placeable_or_exposes_attributes(self):
        self.item.user_id = self.other.id
        self.db.commit()
        row = self.configure()["entries"][0]
        self.assertTrue(row["unresolved"])
        self.assertIsNone(row["condition"])
        self.assert_conflict(lambda: self.move())

    def test_quantity_reduction_deletion_bulk_remove_and_conversion_require_chosen_unplacement(self):
        self.configure()
        self.move()
        operations = [
            lambda: update_binder_entry(self.binder.id, self.entry.id, BinderCardUpdate(required_quantity=1), current_user=self.user, db=self.db),
            lambda: remove_binder_entry(self.binder.id, self.entry.id, current_user=self.user, db=self.db),
            lambda: remove_card_from_binder(self.binder.id, self.a.id, current_user=self.user, db=self.db),
            lambda: delete_binder(self.binder.id, current_user=self.user, db=self.db),
            lambda: convert_collection_binder_to_wishlist(self.binder.id, current_user=self.user, db=self.db),
            lambda: remove_card_list_entries(self.db, self.user.id, self.binder.id, [self.entry.id], deck=False),
        ]
        # One placed copy still fits a reduced quantity of one; the tray alone is
        # reduced. Two placed copies require an explicit choice before reduction.
        self.move(slot=2)
        for operation in operations:
            self.assert_conflict(operation)
            self.assertEqual(self.state()["placed_count"], 2)

    def test_printing_switch_and_merge_require_explicit_return_to_tray(self):
        self.configure()
        self.move()
        with patch("api.binders._ensure_card_gameplay_data", side_effect=lambda db, card: card):
            self.assert_conflict(lambda: switch_binder_entry_card(
                self.binder.id, self.entry.id, BinderCardSwitch(collection_item_id=self.second_item.id), current_user=self.user, db=self.db))

    def test_collection_removal_and_reduction_cannot_lose_reserved_copies(self):
        self.configure()
        self.move()
        self.assert_conflict(lambda: remove_from_collection(self.item.id, current_user=self.user, db=self.db))
        self.assert_conflict(lambda: update_collection_item(self.item.id, CollectionItemUpdate(quantity=2), current_user=self.user, db=self.db))

    def test_collection_release_custom_delete_and_optimizer_do_not_discard_locations(self):
        from api.cards import delete_custom_card
        from api.binders import apply_binder_print_optimization
        from schemas import ReleaseAssignmentsRequest
        from services.collection_removal_conflicts import release_confirmed_assignments
        self.a.is_custom = True
        self.a.custom_owner_id = self.user.id
        self.db.commit()
        self.configure()
        self.move()
        request = ReleaseAssignmentsRequest(item_ids=[self.item.id], assignments=[{
            "assignment_id": self.entry.id, "list_id": self.binder.id,
            "item_id": self.item.id, "quantity": self.entry.required_quantity,
        }])
        self.assert_conflict(lambda: release_confirmed_assignments(self.db, self.user, request))
        self.assert_conflict(lambda: delete_custom_card(self.a.id, current_user=self.user, db=self.db))
        with patch("api.binders._build_print_optimization_preview", return_value={"recommendations": [{"binder_card_id": self.entry.id}]}):
            self.assert_conflict(lambda: apply_binder_print_optimization(self.binder.id, current_user=self.user, db=self.db))
        self.assertEqual(self.state()["placed_count"], 1)

    def test_full_binder_can_still_have_unplaced_copies(self):
        self.entry.required_quantity = 10
        self.item.quantity = 10
        self.db.commit()
        self.configure(1)
        for slot in range(1, 10):
            self.move(slot=slot)
        self.assertEqual((self.state()["placed_count"], self.state()["unplaced_count"]), (9, 3))

    def test_location_lookup_has_multiple_binders_and_exact_item_filter(self):
        other = Binder(name="Other binder", user_id=self.user.id, binder_type="collection")
        self.db.add(other)
        self.db.flush()
        self.db.add(BinderCard(binder_id=other.id, card_id=self.a.id, collection_item_id=None, required_quantity=1))
        self.db.commit()
        locations = card_locations(self.db, self.user.id, self.a.id)["locations"]
        self.assertEqual(len(locations), 2)
        self.assertEqual(card_locations(self.db, self.other.id, self.a.id)["locations"], [])
        self.assertEqual(len(card_locations(self.db, self.user.id, self.a.id, collection_item_id=self.item.id)["locations"]), 1)

    def test_public_layout_and_locations_are_sanitized_and_visibility_gated(self):
        self.configure()
        self.move()
        state = get_public_binder_layout("binder-owner", self.binder.id, db=self.db)
        self.assertNotIn("revision", state)
        self.assertNotIn("can_undo", state)
        row = state["entries"][0]
        self.assertNotIn("condition", row)
        self.assertNotIn("collection_item_id", row)
        self.assertNotIn("example.com", row["images_small"])
        self.assertEqual(len(get_public_card_locations("binder-owner", self.a.id, db=self.db)["locations"]), 2)
        self.binder.is_public = False
        self.db.commit()
        self.assert_conflict(lambda: get_public_binder_layout("binder-owner", self.binder.id, db=self.db), 404)
        self.assertEqual(get_public_card_locations("binder-owner", self.a.id, db=self.db)["locations"], [])
        self.user.is_profile_public = False
        self.db.commit()
        self.assert_conflict(lambda: get_public_card_locations("binder-owner", self.a.id, db=self.db), 404)

    def test_layout_validation_and_unique_pocket_constraint(self):
        for data in ({"page_count": 0}, {"page_count": 501}, {"rows": 4}, {"columns": 2}):
            with self.assertRaises(ValidationError):
                BinderLayoutPreview(**data)
        self.configure()
        self.move()
        self.db.add(BinderPlacement(id="invalid-duplicate", binder_id=self.binder.id, binder_card_id=self.second.id, page=1, slot=1))
        with self.assertRaises(IntegrityError):
            self.db.commit()
        self.db.rollback()
        self.assertEqual(self.state()["placed_count"], 1)

    def test_first_page_single_round_trips_and_undo_restores(self):
        self.configure()
        self.assertFalse(self.state()["layout"]["first_page_single"])
        enabled = self.configure(first_page_single=True)
        self.assertTrue(enabled["layout"]["first_page_single"])
        self.assertTrue(self.state()["layout"]["first_page_single"])
        self.assertTrue(self.db.get(Binder, self.binder.id).layout_first_page_single)
        self.assertFalse(self.undo()["layout"]["first_page_single"])
        self.assertFalse(self.state()["layout"]["first_page_single"])

    def test_first_page_single_toggle_changes_revision_and_rejects_stale_move(self):
        stale_revision = self.configure()["revision"]
        toggled = self.configure(first_page_single=True)
        self.assertNotEqual(toggled["revision"], stale_revision)
        self.assert_conflict(lambda: self.move(revision=stale_revision))
        self.assertEqual(self.move()["placed_count"], 1)

    def test_first_page_single_toggle_keeps_placements_and_affected(self):
        self.configure()
        self.move()
        self.move(entry=self.second, slot=2)
        before = self.state()["placements"]
        preview = preview_layout(self.db, self.binder, BinderLayoutPreview(page_count=2, first_page_single=True))
        self.assertEqual(preview["affected"], [])
        self.assertEqual(self.configure(first_page_single=True)["placements"], before)

    def test_disabling_layout_clears_first_page_single(self):
        self.configure(1, first_page_single=True)
        result = self.configure(None)
        self.assertIsNone(result["layout"])
        self.assertFalse(self.db.get(Binder, self.binder.id).layout_first_page_single)
        self.assertFalse(self.configure()["layout"]["first_page_single"])

    def test_scan_photo_presence_is_owner_scoped_and_never_public(self):
        state = self.configure()
        self.assertTrue(all(row["has_scan_photo"] is False for row in state["entries"]))
        self.db.add(CollectionCardPhoto(user_id=self.user.id, card_id=self.a.id, data=b"jpeg"))
        self.db.commit()
        presence = {row["card_id"]: row["has_scan_photo"] for row in self.state()["entries"]}
        self.assertEqual(presence, {self.a.id: True, self.b.id: False})
        public = get_public_binder_layout("binder-owner", self.binder.id, db=self.db)
        self.assertTrue(all("has_scan_photo" not in row for row in public["entries"]))

    def test_catalogue_identity_reaches_the_pocket_for_holo_effects(self):
        # The foil overlay resolves its map from tcg_card_id, so the pocket needs
        # the catalogue identity in both the private and shared payloads.
        self.a.tcg_card_id = "sv-1"
        self.b.tcg_card_id = "sv-2"
        self.db.commit()
        state = self.configure()
        self.assertEqual({row["card_id"]: row["tcg_card_id"] for row in state["entries"]},
                         {self.a.id: "sv-1", self.b.id: "sv-2"})
        public = get_public_binder_layout("binder-owner", self.binder.id, db=self.db)
        self.assertEqual({row["card_id"]: row["tcg_card_id"] for row in public["entries"]},
                         {self.a.id: "sv-1", self.b.id: "sv-2"})

    def test_migration_rerun_preserves_contents_and_placements(self):
        self.configure()
        self.move()
        before = self.state()
        self.db.close()
        migrate_binder_layout_schema(self.engine)
        migrate_binder_layout_schema(self.engine)
        self.assertEqual(self.state(), before)

    def test_failed_save_rolls_back_entire_swap(self):
        self.configure()
        first = self.move()["placements"][0]
        self.move(entry=self.second, slot=2)
        before = self.state()
        with patch.object(self.db, "commit", side_effect=RuntimeError("save failed")):
            with self.assertRaisesRegex(RuntimeError, "save failed"):
                self.move(source=first["id"], slot=2, confirm=True)
        self.assertEqual(self.state(), before)

    def test_http_contract_owner_auth_validation_and_public_readonly(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from api.auth import get_current_user
        from api.binders import router as binders_router
        from api.cards import router as cards_router
        from api.public import router as public_router
        from database import get_db
        app = FastAPI()
        app.include_router(binders_router, prefix="/api/binders")
        app.include_router(cards_router, prefix="/api/cards")
        app.include_router(public_router, prefix="/api/public")
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[get_current_user] = lambda: self.user
        client = TestClient(app)
        url = f"/api/binders/{self.binder.id}/layout"
        state = client.get(url).json()
        self.assertEqual(client.get(url).headers["cache-control"], "no-store")
        self.assertEqual(client.put(url, json={"page_count": 2}).status_code, 422)
        result = client.put(url, json={"page_count": 2, "expected_revision": state["revision"]})
        self.assertEqual(result.status_code, 200)
        move = client.post(f"/api/binders/{self.binder.id}/placements", json={
            "binder_card_id": self.entry.id, "page": 2, "slot": 4, "expected_revision": result.json()["revision"],
        })
        self.assertEqual(move.status_code, 200)
        locations = client.get(f"/api/cards/{self.a.id}/locations").json()["locations"]
        self.assertEqual([(r["page"], r["slot"]) for r in locations], [(2, 4), (None, None)])
        shared = f"/api/public/profiles/binder-owner/binders/{self.binder.id}/layout"
        self.assertEqual(client.get(shared).status_code, 200)
        self.assertEqual(client.post(shared, json={}).status_code, 405)
        app.dependency_overrides[get_current_user] = lambda: self.other
        self.assertEqual(client.get(url).status_code, 404)
        self.assertEqual(client.post(f"/api/binders/{self.binder.id}/placements", json={
            "binder_card_id": self.entry.id, "page": 1, "slot": 1, "expected_revision": move.json()["revision"],
        }).status_code, 404)

    def test_explicit_account_erasure_cleans_only_that_owners_locations(self):
        from api.auth import delete_user
        self.configure()
        self.move()
        target_id = self.user.id
        self.other.role = "admin"
        self.db.commit()
        with patch("api.auth.ensure_admin_transition_keeps_usable_admin"), patch("services.scan_trace.revoke_user_traces"):
            result = delete_user(target_id, current_user=self.other, db=self.db)
        self.assertEqual(result, {"message": "User deleted"})
        self.assertEqual(self.db.query(BinderPlacement).count(), 0)
        self.assertIsNotNone(self.db.get(User, self.other.id))


if __name__ == "__main__":
    unittest.main()
