import unittest
from unittest.mock import MagicMock, patch

try:
    import services.scheduler as scheduler

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


@unittest.skipUnless(DEPS_AVAILABLE, "Scheduler dependencies are not installed")
class JpPriceSyncGuardTests(unittest.TestCase):
    def setUp(self):
        scheduler._jp_price_sync_running = False

    def tearDown(self):
        scheduler._jp_price_sync_running = False

    def test_skips_when_already_running(self):
        scheduler._jp_price_sync_running = True
        with patch("database.SessionLocal") as session_local:
            scheduler.run_jp_price_sync()
        session_local.assert_not_called()
        self.assertTrue(scheduler.is_jp_price_sync_running())

    def test_runs_and_clears_flag_when_idle(self):
        db = MagicMock()
        with patch("database.SessionLocal", return_value=db), \
                patch("services.suruga_ya_pricing.sync_jp_prices_for_collection",
                      return_value={"attempted": 1, "updated": 1, "no_match": 0, "failed": 0}):
            scheduler.run_jp_price_sync()
        self.assertFalse(scheduler.is_jp_price_sync_running())
        db.close.assert_called_once_with()

    def test_scheduler_trigger_and_manual_trigger_share_one_flag(self):
        # Simulates the exact race this guard fixes: the scheduler's own
        # interval trigger and the manual /api/sync/prices/jp endpoint both
        # end up calling run_jp_price_sync() — a second concurrent call must
        # be a no-op, not a second full sync.
        db = MagicMock()

        def slow_sync(_db):
            self.assertTrue(scheduler.is_jp_price_sync_running())
            with patch("database.SessionLocal") as second_call_session_local:
                scheduler.run_jp_price_sync()
            second_call_session_local.assert_not_called()
            return {"attempted": 1, "updated": 1, "no_match": 0, "failed": 0}

        with patch("database.SessionLocal", return_value=db), \
                patch("services.suruga_ya_pricing.sync_jp_prices_for_collection", side_effect=slow_sync):
            scheduler.run_jp_price_sync()

        self.assertFalse(scheduler.is_jp_price_sync_running())


if __name__ == "__main__":
    unittest.main()
