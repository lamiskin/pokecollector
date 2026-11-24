"""Creating a manual card from a scan that matched nothing."""

import datetime
import unittest
from unittest.mock import patch

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from api.auth import get_current_user
    from api.scan_jobs import router
    from database import Base, get_db
    from models import Binder, BinderCard, Card, CollectionItem, ScanJob, ScanJobItem, Set, User

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


@unittest.skipUnless(DEPS_AVAILABLE, "Scanner API dependencies are not installed")
class ScanCreateCustomCardTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.user = User(username="scan-custom-owner", hashed_password="x", is_active=True)
        self.other_user = User(username="scan-custom-other", hashed_password="x", is_active=True)
        self.db.add_all([self.user, self.other_user])
        self.db.commit()

        app = FastAPI()
        app.include_router(router, prefix="/api/cards")

        def override_db():
            yield self.db

        app.dependency_overrides[get_db] = override_db
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.app = app
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.db.close()
        self.engine.dispose()

    def _job(self, *, user=None, binder_id=None):
        job = ScanJob(
            user_id=(user or self.user).id,
            status="done",
            binder_id=binder_id,
            expires_at=datetime.datetime.utcnow() + datetime.timedelta(days=14),
        )
        self.db.add(job)
        self.db.commit()
        return job

    def _matcher_miss_item(self, job, *, status="done", image_path="jobs/1/card.jpg"):
        """A scan the recogniser could not match to any candidate."""
        item = ScanJobItem(
            job_id=job.id,
            user_id=job.user_id,
            position=0,
            image_path=image_path,
            byte_size=128,
            status=status,
            matches=[],
            no_candidates=True,
        )
        self.db.add(item)
        self.db.commit()
        return item

    def _payload(self, **overrides):
        payload = {
            "name": "Misprint Pikachu",
            "number": "58",
            "set_id": "mystery-set",
            "set_name": "Mystery Set",
            "rarity": "Rare",
            "image_url": "https://8.8.8.8/misprint.jpg",
        }
        payload.update(overrides)
        return payload

    def _create_custom(self, job_id, item_id, **overrides):
        return self.client.post(
            f"/api/cards/recognize/jobs/{job_id}/items/{item_id}/create-custom",
            json=self._payload(**overrides),
        )

    def test_creates_custom_card_one_owned_copy_and_resolves_the_item(self):
        job = self._job()
        item = self._matcher_miss_item(job)

        response = self._create_custom(job.id, item.id)

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(set(body), {"card", "collection_item"})

        card = body["card"]
        self.assertTrue(card["id"].startswith("custom-"))
        self.assertTrue(card["is_custom"])
        self.assertTrue(card["is_custom_owner"])
        self.assertEqual(card["name"], "Misprint Pikachu")
        self.assertEqual(card["number"], "58")
        self.assertEqual(card["set_id"], "mystery-set")
        self.assertEqual(card["rarity"], "Rare")
        self.assertEqual(card["images_small"], "https://8.8.8.8/misprint.jpg")
        self.assertEqual(card["images_large"], "https://8.8.8.8/misprint.jpg")

        collection_item = body["collection_item"]
        self.assertEqual(collection_item["card_id"], card["id"])
        self.assertEqual(collection_item["quantity"], 1)
        self.assertEqual(collection_item["condition"], "NM")
        self.assertEqual(collection_item["variant"], "Normal")
        self.assertEqual(collection_item["lang"], "en")

        stored = self.db.get(ScanJobItem, item.id)
        self.assertTrue(stored.resolved)
        # The client still needs the photo to attach it as the private copy.
        self.assertEqual(stored.image_path, "jobs/1/card.jpg")

    def test_creates_a_stub_set_when_the_set_is_unknown(self):
        job = self._job()
        item = self._matcher_miss_item(job)

        response = self._create_custom(job.id, item.id)

        self.assertEqual(response.status_code, 200, response.text)
        stub = self.db.query(Set).filter(Set.id == "mystery-set").one()
        self.assertEqual(stub.name, "Mystery Set")
        self.assertEqual(stub.tcg_set_id, "mystery-set")
        self.assertEqual(stub.lang, "en")

    def test_creates_from_a_failed_scan(self):
        job = self._job()
        item = self._matcher_miss_item(job, status="failed")

        response = self._create_custom(job.id, item.id)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(self.db.get(ScanJobItem, item.id).resolved)
        self.assertEqual(self.db.query(CollectionItem).count(), 1)

    def test_rejects_another_users_scan_item(self):
        job = self._job(user=self.other_user)
        item = self._matcher_miss_item(job)
        self.app.dependency_overrides[get_current_user] = lambda: self.user

        response = self._create_custom(job.id, item.id)

        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.db.query(Card).filter(Card.is_custom == True).count(), 0)
        self.assertEqual(self.db.query(CollectionItem).count(), 0)
        self.assertFalse(self.db.get(ScanJobItem, item.id).resolved)

    def test_rejects_an_already_resolved_item(self):
        job = self._job()
        item = self._matcher_miss_item(job)
        item.resolved = True
        self.db.commit()

        response = self._create_custom(job.id, item.id)

        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.db.query(Card).filter(Card.is_custom == True).count(), 0)

    def _create_binder(self, binder_type="collection", name="Scan Target"):
        binder = Binder(name=name, user_id=self.user.id, binder_type=binder_type)
        self.db.add(binder)
        self.db.commit()
        return binder

    def test_files_the_new_copy_into_the_jobs_destination_list(self):
        binder = self._create_binder()
        job = self._job(binder_id=binder.id)
        item = self._matcher_miss_item(job)

        response = self._create_custom(job.id, item.id)

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        collection_item_id = body["collection_item"]["id"]
        allocation = self.db.query(BinderCard).filter(
            BinderCard.binder_id == binder.id,
            BinderCard.collection_item_id == collection_item_id,
        ).one()
        self.assertEqual(allocation.card_id, body["card"]["id"])
        self.assertEqual(allocation.required_quantity, 1)
        self.assertEqual(body["collection_item"]["allocated_quantity"], 1)
        self.assertEqual(body["collection_item"]["available_quantity"], 0)

    def test_job_without_a_destination_leaves_the_copy_unallocated(self):
        job = self._job()
        item = self._matcher_miss_item(job)

        response = self._create_custom(job.id, item.id)

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["collection_item"]["quantity"], 1)
        self.assertEqual(body["collection_item"]["allocated_quantity"], 0)
        self.assertEqual(body["collection_item"]["available_quantity"], 1)
        self.assertEqual(self.db.query(BinderCard).count(), 0)

    def test_does_not_call_tcgdex(self):
        job = self._job()
        item = self._matcher_miss_item(job)

        with patch(
            "services.pokemon_api.get_card",
            side_effect=AssertionError("create-custom must not call TCGdex"),
        ), patch(
            "services.pokemon_api.get_set_cards",
            side_effect=AssertionError("create-custom must not call TCGdex"),
        ):
            response = self._create_custom(job.id, item.id)

        self.assertEqual(response.status_code, 200, response.text)

    def test_rejects_an_unsafe_image_url(self):
        job = self._job()
        item = self._matcher_miss_item(job)

        response = self._create_custom(job.id, item.id, image_url="http://127.0.0.1/secret.jpg")

        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.db.query(Card).filter(Card.is_custom == True).count(), 0)
        self.assertFalse(self.db.get(ScanJobItem, item.id).resolved)


if __name__ == "__main__":
    unittest.main()
