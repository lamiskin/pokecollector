"""Opt-in: real deferred constraints, legacy upgrades, and concurrent moves."""
import concurrent.futures
import os
import threading
import unittest
import uuid

from fastapi import HTTPException
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from api.binder_layouts import move_binder_copy, update_binder_layout, undo_binder_layout
from api.binders import update_binder_entry
from database import Base
from models import Binder, BinderCard, BinderPlacement, Card, CollectionItem, User
from schemas import BinderCardUpdate, BinderLayoutUpdate, BinderLayoutUndo, BinderPlacementMove
from services.binder_layout_schema import migrate_binder_layout_schema
from services.binder_layouts import layout_state


ENABLED = os.getenv("BINDER_LAYOUTS_POSTGRES_TEST") == "1" and os.getenv("DATABASE_URL", "").startswith("postgresql")


@unittest.skipUnless(ENABLED, "requires an isolated PostgreSQL physical binder test database")
class BinderLayoutPostgresTests(unittest.TestCase):
    def setUp(self):
        self.schema = "binder_layout_test_" + uuid.uuid4().hex
        self.admin_engine = create_engine(os.environ["DATABASE_URL"])
        with self.admin_engine.begin() as conn:
            conn.execute(text(f'CREATE SCHEMA "{self.schema}"'))
        self.engine = create_engine(os.environ["DATABASE_URL"], connect_args={"options": f"-csearch_path={self.schema}"})
        Base.metadata.create_all(self.engine)
        migrate_binder_layout_schema(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        user = User(username="layout-owner", hashed_password="x", is_active=True)
        other = User(username="layout-other", hashed_password="x", is_active=True)
        cards = [Card(id=f"example-{i}_en", name=f"Example {i}", lang="en") for i in (1, 2)]
        self.db.add_all([user, other, *cards])
        self.db.flush()
        binder = Binder(name="Physical binder", user_id=user.id, binder_type="collection")
        second_binder = Binder(name="Other binder", user_id=user.id, binder_type="collection")
        items = [CollectionItem(user_id=user.id, card_id=c.id, quantity=3, variant="Normal") for c in cards]
        self.db.add_all([binder, second_binder, *items])
        self.db.flush()
        entries = [BinderCard(binder_id=binder.id, card_id=c.id, collection_item_id=item.id, required_quantity=3)
                   for c, item in zip(cards, items)]
        self.db.add_all(entries)
        self.db.commit()
        self.user_id, self.other_id = user.id, other.id
        self.binder_id, self.other_binder_id = binder.id, second_binder.id
        self.entry_id, self.second_entry_id = [e.id for e in entries]
        self.item_id = items[0].id
        self.configure()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        with self.admin_engine.begin() as conn:
            # Only this test's uniquely named schema; never public/live data.
            conn.execute(text(f'DROP SCHEMA "{self.schema}" CASCADE'))
        self.admin_engine.dispose()

    def state(self, db=None):
        db = db or self.db
        binder = db.query(Binder).filter(Binder.id == self.binder_id).populate_existing().one()
        return layout_state(db, binder)

    def configure(self):
        return update_binder_layout(self.binder_id, BinderLayoutUpdate(page_count=2, expected_revision=self.state()["revision"]),
                                   current_user=self.db.get(User, self.user_id), db=self.db)

    def move(self, *, db=None, entry_id=None, page=1, slot=1, revision=None, source=None, confirm=False):
        db = db or self.db
        return move_binder_copy(self.binder_id, BinderPlacementMove(
            binder_card_id=entry_id or self.entry_id, page=page, slot=slot,
            expected_revision=revision or self.state(db)["revision"], placement_id=source, confirm_occupied=confirm,
        ), current_user=db.get(User, self.user_id), db=db)

    def raw_placement(self, *, binder_id=None, entry_id=None, page=1, slot=1):
        self.db.add(BinderPlacement(id=str(uuid.uuid4()), binder_id=binder_id or self.binder_id,
                                   binder_card_id=entry_id or self.entry_id, page=page, slot=slot))

    def assert_invalid(self, operation):
        with self.assertRaises(IntegrityError):
            operation()
            self.db.commit()
        self.db.rollback()

    def race(self, left, right):
        barrier = threading.Barrier(2)
        def run(operation):
            with self.Session() as db:
                barrier.wait(timeout=10)
                try:
                    return operation(db)
                except HTTPException as exc:
                    db.rollback()
                    return exc.status_code
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(run, operation) for operation in (left, right)]
            return [f.result(timeout=15) for f in futures]

    def test_revision_and_undo_use_final_trigger_updated_state(self):
        initial = self.move()
        self.assertEqual(initial["revision"], self.state()["revision"])
        self.assertTrue(self.state()["can_undo"])
        result = undo_binder_layout(self.binder_id, BinderLayoutUndo(expected_revision=initial["revision"]),
                                    current_user=self.db.get(User, self.user_id), db=self.db)
        self.assertEqual(result["placed_count"], 0)
        self.assertFalse(result["can_undo"])

    def test_deferred_bounds_membership_and_quantity_constraints(self):
        for values in ({"page": 3}, {"slot": 10}, {"binder_id": self.other_binder_id}):
            self.assert_invalid(lambda values=values: self.raw_placement(**values))
        for slot in range(1, 4):
            self.raw_placement(slot=slot)
        self.db.commit()
        self.assert_invalid(lambda: self.raw_placement(slot=4))
        self.assertEqual(self.state()["placed_count"], 3)

    def test_cross_owner_inventory_link_and_unresolved_member_rejected(self):
        self.move()
        def foreign_inventory():
            self.db.get(CollectionItem, self.item_id).user_id = self.other_id
        self.assert_invalid(foreign_inventory)
        def unresolved():
            self.db.get(BinderCard, self.entry_id).collection_item_id = None
        self.assert_invalid(unresolved)

    def test_quantity_reduction_type_conversion_and_occupied_deletion_rejected_in_database(self):
        self.move()
        def reduce():
            self.db.get(BinderCard, self.entry_id).required_quantity = 0
        self.assert_invalid(reduce)
        def convert():
            self.db.get(Binder, self.binder_id).binder_type = "wishlist"
        self.assert_invalid(convert)
        self.assert_invalid(lambda: self.db.delete(self.db.get(BinderCard, self.entry_id)))
        self.assertEqual(self.state()["placed_count"], 1)

    def test_raw_overallocation_and_inventory_reduction_cannot_duplicate_placed_stock(self):
        self.move()
        self.assert_invalid(lambda: setattr(self.db.get(CollectionItem, self.item_id), "quantity", 2))
        self.assert_invalid(lambda: self.db.add(BinderCard(
            binder_id=self.other_binder_id, card_id="example-1_en", collection_item_id=self.item_id, required_quantity=1)))
        self.assertEqual(self.state()["entries"][0]["quantity"], 3)

    def test_printing_correction_preserves_position_when_final_links_match(self):
        before = self.move()["placements"][0]
        self.db.execute(text("UPDATE binder_cards SET card_id='example-2_en' WHERE id=:id"), {"id": self.entry_id})
        self.db.execute(text("UPDATE collection SET card_id='example-2_en' WHERE id=:id"), {"id": self.item_id})
        self.db.commit()
        p = self.state()["placements"][0]
        self.assertEqual((p["id"], p["page"], p["slot"]), (before["id"], 1, 1))
        self.assertEqual(p["card_id"], "example-2_en")
        self.assertFalse(self.state()["can_undo"])

    def test_parallel_moves_to_one_empty_pocket_accept_exactly_one(self):
        revision = self.state()["revision"]
        self.db.rollback()
        results = self.race(lambda db: self.move(db=db, revision=revision),
                            lambda db: self.move(db=db, revision=revision, entry_id=self.second_entry_id))
        self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        self.assertIn(409, results)
        self.assertEqual(self.state()["placed_count"], 1)

    def test_parallel_moves_of_one_copy_cannot_duplicate_it(self):
        state = self.move()
        source = state["placements"][0]["id"]
        self.db.rollback()
        results = self.race(lambda db: self.move(db=db, revision=state["revision"], source=source, slot=2),
                            lambda db: self.move(db=db, revision=state["revision"], source=source, page=2))
        self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        self.assertIn(409, results)
        self.assertEqual(self.state()["placed_count"], 1)

    def test_quantity_reduction_racing_placement_never_makes_negative_tray(self):
        revision = self.state()["revision"]
        self.db.rollback()
        def reduce(db):
            return update_binder_entry(self.binder_id, self.entry_id, BinderCardUpdate(required_quantity=1),
                                       current_user=db.get(User, self.user_id), db=db)
        self.race(lambda db: self.move(db=db, revision=revision), reduce)
        state = self.state()
        self.assertGreaterEqual(state["entries"][0]["unplaced_quantity"], 0)
        self.assertEqual(state["entries"][0]["quantity"], 1)

    def test_atomic_swap_and_replace_undo_keep_physical_identities(self):
        first = self.move()["placements"][0]
        self.move(entry_id=self.second_entry_id, slot=2)
        before = self.state()["placements"]
        state = self.move(source=first["id"], slot=2, confirm=True)
        self.assertEqual(state["placed_count"], 2)
        undone = undo_binder_layout(self.binder_id, BinderLayoutUndo(expected_revision=state["revision"]),
                                    current_user=self.db.get(User, self.user_id), db=self.db)
        self.assertEqual(undone["placements"], before)

    def test_membership_change_and_return_to_same_quantity_still_invalidates_undo(self):
        before = self.move()
        entry = self.db.get(BinderCard, self.entry_id)
        entry.required_quantity = 2
        self.db.commit()
        entry.required_quantity = 3
        self.db.commit()
        self.assertNotEqual(self.state()["revision"], before["revision"])
        self.assertFalse(self.state()["can_undo"])

    def test_migration_rerun_preserves_occupied_layout_and_undo(self):
        before = self.move()
        self.db.rollback()
        migrate_binder_layout_schema(self.engine)
        migrate_binder_layout_schema(self.engine)
        self.assertEqual(self.state(), before)

    def test_upgrade_from_pre_layout_schema_keeps_legacy_membership_unplaced(self):
        self.db.rollback()
        with self.engine.begin() as conn:
            conn.execute(text("DROP TABLE binder_placements CASCADE"))
            conn.execute(text("ALTER TABLE binders DROP CONSTRAINT ck_binders_layout"))
            for column in ("layout_pages", "layout_rows", "layout_columns", "layout_revision", "layout_undo"):
                conn.execute(text(f"ALTER TABLE binders DROP COLUMN {column}"))
        migrate_binder_layout_schema(self.engine)
        migrate_binder_layout_schema(self.engine)
        self.db.expire_all()
        state = self.state()
        self.assertIsNone(state["layout"])
        self.assertEqual(state["placed_count"], 0)
        self.assertEqual(state["unplaced_count"], 6)
        self.assertEqual(self.db.get(CollectionItem, self.item_id).quantity, 3)


if __name__ == "__main__":
    unittest.main()
