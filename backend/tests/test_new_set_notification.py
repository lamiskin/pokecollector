import datetime
import unittest
from unittest.mock import patch

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from database import Base
    from models import Set, SyncLog, UserSetting
    from services.sync_service import (
        _notify_new_sets,
        _telegram_recipient_user_ids,
        perform_full_sync,
    )

    DEPS = True
except ModuleNotFoundError:
    DEPS = False


def _set_payload(set_id, name, *, series="Base", digital=False):
    return {
        "id": set_id,
        "name": name,
        "serie": {"name": series, "id": "tcgp" if digital else "base"},
        "_lang": "en",
        "releaseDate": "2020/01/01",
        "cardCount": {"total": 1},
        "logo": ("https://images.tcgdex.net/tcgp/x" if digital else "https://images.tcgdex.net/base/x"),
    }


EMPTY_PRICE_PLAN = {
    "ids": [],
    "sync_limit": 1000,
    "total_syncable": 0,
    "selected_missing": 0,
    "selected_priced": 0,
    "eligible_missing": 0,
    "cooldown_missing": 0,
    "priced": 0,
    "deferred": 0,
    "deferred_ids": [],
}

EMPTY_METADATA_RESULT = {
    "attempted": 0,
    "updated": 0,
    "refreshed": 0,
    "missing": 0,
    "failed": 0,
    "deferred": 0,
    "ids": [],
}


@unittest.skipUnless(DEPS, "SQLAlchemy not installed in this lightweight test environment")
class NewSetNotificationTests(unittest.TestCase):
    """New-set Telegram messages fire once, only for real additions.

    A first sync contains the whole catalogue and must stay silent; a sync that
    adds nothing must stay silent; a broken notifier must not fail the sync.
    """

    def setUp(self):
        self.engine = create_engine(
            "sqlite://",
            poolclass=StaticPool,
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine, autoflush=False)

    def tearDown(self):
        self.engine.dispose()

    def _seed_set(self, set_id):
        db = self.Session()
        try:
            db.add(
                Set(
                    id=set_id,
                    tcg_set_id=set_id,
                    name=f"Existing {set_id}",
                    total=1,
                    lang="en",
                )
            )
            db.commit()
        finally:
            db.close()

    def _run_full_sync(self, sets_payload, notify):
        db = self.Session()
        try:
            with patch("services.sync_service._get_tcgdex_sync_languages", return_value=["en"]), \
                    patch("services.sync_service.digital_sets_enabled", return_value=False), \
                    patch(
                        "services.sync_service.refresh_digital_catalogue_flags",
                        return_value={"sets_marked": 0, "cards_marked": 0},
                    ), \
                    patch("services.sync_service.get_pinned_set_language_pairs", return_value=set()), \
                    patch(
                        "services.sync_service.pokemon_api.get_all_sets",
                        return_value=sets_payload,
                    ), \
                    patch(
                        "services.sync_service._sync_set_card_catalogue",
                        return_value={
                            "sets_refreshed": 0,
                            "complete_sets_refreshed": 0,
                            "complete_sets_skipped": 0,
                        },
                    ), \
                    patch(
                        "services.sync_service.enrich_missing_card_metadata",
                        return_value=EMPTY_METADATA_RESULT,
                    ), \
                    patch("services.sync_service._price_sync_plan", return_value=EMPTY_PRICE_PLAN), \
                    patch("services.sync_service.take_portfolio_snapshot"), \
                    patch("services.sync_service.telegram.send_new_sets_notification", notify):
                return perform_full_sync(db), db
        finally:
            db.close()

    def test_notifies_once_with_new_set_names_when_prior_sets_existed(self):
        self._seed_set("sv0")
        payload = [
            _set_payload("sv0", "Existing Set"),
            _set_payload("sv1", "Scarlet & Violet", series="Scarlet & Violet"),
        ]

        with patch(
            "services.sync_service.telegram.send_new_sets_notification",
            return_value=True,
        ) as notify:
            result, _ = self._run_full_sync(payload, notify)

        self.assertEqual(result["status"], "success")
        notify.assert_called_once()
        new_sets = notify.call_args.args[0]
        self.assertEqual([entry["name"] for entry in new_sets], ["Scarlet & Violet"])
        self.assertEqual(new_sets[0]["series"], "Scarlet & Violet")
        self.assertIsNone(notify.call_args.kwargs.get("user_id"))

    def test_silent_on_first_sync(self):
        payload = [
            _set_payload("sv1", "One"),
            _set_payload("sv2", "Two"),
        ]

        with patch(
            "services.sync_service.telegram.send_new_sets_notification",
            return_value=True,
        ) as notify:
            result, _ = self._run_full_sync(payload, notify)

        self.assertEqual(result["status"], "success")
        notify.assert_not_called()

    def test_silent_when_nothing_is_new(self):
        self._seed_set("sv1")
        payload = [_set_payload("sv1", "Existing Set")]

        with patch(
            "services.sync_service.telegram.send_new_sets_notification",
            return_value=True,
        ) as notify:
            result, _ = self._run_full_sync(payload, notify)

        self.assertEqual(result["status"], "success")
        notify.assert_not_called()

    def test_digital_sets_are_not_announced(self):
        self._seed_set("sv0")
        payload = [
            _set_payload("sv0", "Existing Set"),
            _set_payload("tcgp1", "Pocket Set", series="Pokemon TCG Pocket", digital=True),
        ]

        with patch(
            "services.sync_service.telegram.send_new_sets_notification",
            return_value=True,
        ) as notify:
            result, _ = self._run_full_sync(payload, notify)

        self.assertEqual(result["status"], "success")
        notify.assert_not_called()

    def test_raising_notifier_does_not_fail_the_sync(self):
        self._seed_set("sv0")
        payload = [
            _set_payload("sv0", "Existing Set"),
            _set_payload("sv1", "New Set"),
        ]

        with patch(
            "services.sync_service.telegram.send_new_sets_notification",
            side_effect=RuntimeError("telegram down"),
        ) as notify:
            result, _ = self._run_full_sync(payload, notify)

        self.assertEqual(result["status"], "success")
        notify.assert_called_once()
        verify_db = self.Session()
        try:
            logs = verify_db.query(SyncLog).all()
        finally:
            verify_db.close()
        self.assertEqual([log.status for log in logs], ["success"])

    def test_notifies_each_configured_recipient_once(self):
        db = self.Session()
        try:
            # User 1 has a complete pair; user 2 has only a chat id and must be
            # skipped rather than sent a message that cannot be delivered.
            db.add_all(
                [
                    UserSetting(user_id=1, key="telegram_bot_token", value="token"),
                    UserSetting(user_id=1, key="telegram_chat_id", value="chat"),
                    UserSetting(user_id=2, key="telegram_chat_id", value="chat2"),
                ]
            )
            db.commit()

            self.assertEqual(_telegram_recipient_user_ids(db), [1])

            with patch(
                "services.sync_service.telegram.send_new_sets_notification",
                return_value=True,
            ) as notify:
                _notify_new_sets(
                    db,
                    [{"name": "New Set", "series": "Base", "is_digital": False}],
                )

            notify.assert_called_once()
            self.assertEqual(notify.call_args.kwargs.get("user_id"), 1)
        finally:
            db.close()

    def test_global_chat_is_used_when_no_user_is_configured(self):
        db = self.Session()
        try:
            with patch(
                "services.sync_service.telegram.send_new_sets_notification",
                return_value=True,
            ) as notify:
                _notify_new_sets(
                    db, [{"name": "New Set", "series": "Base", "is_digital": False}]
                )

            notify.assert_called_once()
            self.assertIsNone(notify.call_args.kwargs.get("user_id"))
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
