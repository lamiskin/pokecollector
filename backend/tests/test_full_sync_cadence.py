import datetime
import unittest
from unittest.mock import patch

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from database import Base
    from models import SyncLog
    import services.scheduler as scheduler_module

    DEPS = True
except ModuleNotFoundError:
    DEPS = False

UTC = datetime.timezone.utc


def _naive_utc(aware: datetime.datetime) -> datetime.datetime:
    return aware.astimezone(UTC).replace(tzinfo=None)


class _CapturingScheduler:
    """Minimal stand-in for the module-level APScheduler instance."""

    running = False

    def __init__(self):
        self.jobs = {}
        self.started = False

    def add_job(self, func, trigger=None, **options):
        self.jobs[options.get("id")] = {"func": func, "trigger": trigger, **options}

    def start(self):
        self.started = True


@unittest.skipUnless(DEPS, "SQLAlchemy/APScheduler not installed in this environment")
class FullSyncCadenceTests(unittest.TestCase):
    """The full-sync cadence is persisted in sync_log, not derived from uptime.

    A restart must not postpone a due sync, a recent successful sync must still
    postpone the next one, and rows orphaned by a dead process must not linger
    as "running" forever.
    """

    def setUp(self):
        self.engine = create_engine(
            "sqlite://",
            poolclass=StaticPool,
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine, autoflush=False)
        self.now = datetime.datetime.now(UTC)

    def tearDown(self):
        self.engine.dispose()

    def _seed_full_sync(self, *, status, started_at, finished_at=None, sync_type="full"):
        db = self.Session()
        try:
            db.add(
                SyncLog(
                    sync_type=sync_type,
                    status=status,
                    started_at=started_at,
                    finished_at=finished_at,
                )
            )
            db.commit()
        finally:
            db.close()

    def _run_wrapper(self, run_result=None):
        run_result = run_result or {"status": "success"}
        with patch("database.SessionLocal", self.Session), patch.object(
            scheduler_module, "_get_full_sync_interval_days", return_value=5
        ), patch.object(
            scheduler_module, "run_full_sync", return_value=run_result
        ) as run_full_sync:
            result = scheduler_module.run_scheduled_full_sync()
        return result, run_full_sync

    # --- next-run computation -------------------------------------------------

    def test_past_interval_is_due_soon(self):
        last_success = _naive_utc(self.now) - datetime.timedelta(days=10)

        next_run = scheduler_module.next_full_sync_run_time(self.now, 5, last_success)

        self.assertEqual(next_run, self.now + scheduler_module.STARTUP_FULL_SYNC_DELAY)
        self.assertGreater(next_run, self.now)

    def test_recent_success_postpones_next_run(self):
        last_success = _naive_utc(self.now) - datetime.timedelta(days=1)

        next_run = scheduler_module.next_full_sync_run_time(self.now, 5, last_success)

        expected = (last_success + datetime.timedelta(days=5)).replace(tzinfo=UTC)
        self.assertEqual(next_run, expected)
        self.assertGreater(next_run, self.now + datetime.timedelta(days=3))

    def test_no_history_runs_soon_after_startup(self):
        next_run = scheduler_module.next_full_sync_run_time(self.now, 5, None)

        self.assertEqual(next_run, self.now + scheduler_module.STARTUP_FULL_SYNC_DELAY)

    def test_last_success_reads_only_successful_full_rows(self):
        db = self.Session()
        try:
            now = _naive_utc(self.now)
            db.add_all(
                [
                    SyncLog(
                        sync_type="full",
                        status="success",
                        started_at=now - datetime.timedelta(days=9),
                        finished_at=now - datetime.timedelta(days=9),
                    ),
                    SyncLog(
                        sync_type="full",
                        status="success",
                        started_at=now - datetime.timedelta(days=4),
                        finished_at=now - datetime.timedelta(days=4),
                    ),
                    SyncLog(
                        sync_type="full",
                        status="error",
                        started_at=now - datetime.timedelta(days=1),
                        finished_at=now - datetime.timedelta(days=1),
                    ),
                    SyncLog(
                        sync_type="price",
                        status="success",
                        started_at=now - datetime.timedelta(hours=2),
                        finished_at=now - datetime.timedelta(hours=2),
                    ),
                ]
            )
            db.commit()

            last_success = scheduler_module.last_successful_full_sync_finished_at(db)

            self.assertEqual(last_success, now - datetime.timedelta(days=4))
        finally:
            db.close()

    # --- scheduler-only wrapper ----------------------------------------------

    def test_scheduled_wrapper_skips_after_recent_success(self):
        now = _naive_utc(self.now)
        self._seed_full_sync(
            status="success",
            started_at=now - datetime.timedelta(days=1, hours=1),
            finished_at=now - datetime.timedelta(days=1),
        )

        result, run_full_sync = self._run_wrapper()

        self.assertEqual(result["status"], "skipped")
        self.assertIn("last successful full sync", result["reason"])
        run_full_sync.assert_not_called()

    def test_scheduled_wrapper_runs_when_interval_elapsed(self):
        now = _naive_utc(self.now)
        self._seed_full_sync(
            status="success",
            started_at=now - datetime.timedelta(days=6),
            finished_at=now - datetime.timedelta(days=6),
        )

        result, run_full_sync = self._run_wrapper({"status": "success"})

        self.assertEqual(result, {"status": "success"})
        run_full_sync.assert_called_once_with()

    def test_scheduled_wrapper_runs_without_history(self):
        result, run_full_sync = self._run_wrapper({"status": "success"})

        self.assertEqual(result, {"status": "success"})
        run_full_sync.assert_called_once_with()

    def test_failed_sync_does_not_reset_the_cadence(self):
        now = _naive_utc(self.now)
        self._seed_full_sync(
            status="error",
            started_at=now - datetime.timedelta(days=7),
            finished_at=now - datetime.timedelta(days=7),
        )

        _, run_full_sync = self._run_wrapper({"status": "success"})

        run_full_sync.assert_called_once_with()

    # --- startup registration -------------------------------------------------

    def test_startup_derives_next_run_from_last_success(self):
        now = _naive_utc(self.now)
        self._seed_full_sync(
            status="success",
            started_at=now - datetime.timedelta(days=1, hours=1),
            finished_at=now - datetime.timedelta(days=1),
        )
        fake_scheduler = _CapturingScheduler()

        with patch("database.SessionLocal", self.Session), patch.object(
            scheduler_module, "scheduler", fake_scheduler
        ), patch.object(
            scheduler_module, "_get_full_sync_interval_days", return_value=5
        ), patch(
            "services.pokedex_backfill.startup_pokedex_backfill_enabled",
            return_value=False,
        ):
            scheduler_module.start_scheduler()

        job = fake_scheduler.jobs["full_sync_job"]
        self.assertIs(job["func"], scheduler_module.run_scheduled_full_sync)
        self.assertEqual(
            job["next_run_time"],
            (now - datetime.timedelta(days=1) + datetime.timedelta(days=5)).replace(tzinfo=UTC),
        )
        self.assertTrue(job["coalesce"])
        self.assertEqual(job["max_instances"], 1)
        self.assertEqual(
            job["misfire_grace_time"], scheduler_module.FULL_SYNC_MISFIRE_GRACE_SECONDS
        )
        self.assertTrue(fake_scheduler.started)

    def test_startup_registers_artwork_sweep_job(self):
        fake_scheduler = _CapturingScheduler()

        with patch("database.SessionLocal", self.Session), patch.object(
            scheduler_module, "scheduler", fake_scheduler
        ), patch.object(
            scheduler_module, "_get_full_sync_interval_days", return_value=5
        ), patch(
            "services.pokedex_backfill.startup_pokedex_backfill_enabled",
            return_value=False,
        ):
            scheduler_module.start_scheduler()

        job = fake_scheduler.jobs["artwork_sweep_job"]
        self.assertIs(job["func"], scheduler_module.run_artwork_sweep_job)
        self.assertEqual(job["trigger"].interval, datetime.timedelta(hours=6))
        self.assertIsNotNone(job["next_run_time"].tzinfo)
        delay = job["next_run_time"] - datetime.datetime.now(UTC)
        self.assertLessEqual(delay, scheduler_module.ARTWORK_SWEEP_STARTUP_DELAY)
        self.assertGreater(delay, datetime.timedelta(0))
        self.assertTrue(job["coalesce"])
        self.assertEqual(job["max_instances"], 1)

    def test_artwork_sweep_job_uses_setting_limit(self):
        stats = {"sets_checked": 1, "sets_failed": 0, "cards_updated": 2, "remaining": 3}

        with patch.object(
            scheduler_module, "_get_artwork_sweep_batch_size", return_value=40
        ), patch(
            "services.artwork_backfill.run_artwork_sweep", return_value=stats
        ) as sweep:
            result = scheduler_module.run_artwork_sweep_job()

        sweep.assert_called_once_with(limit=40)
        self.assertEqual(result, stats)

    def test_artwork_sweep_job_swallows_errors(self):
        with patch.object(
            scheduler_module, "_get_artwork_sweep_batch_size", return_value=40
        ), patch(
            "services.artwork_backfill.run_artwork_sweep",
            side_effect=RuntimeError("catalogue down"),
        ), patch.object(scheduler_module.logger, "exception") as log_exception:
            result = scheduler_module.run_artwork_sweep_job()

        log_exception.assert_called_once()

        self.assertEqual(result["status"], "error")
        self.assertIn("catalogue down", result["error"])

    # --- orphaned rows --------------------------------------------------------

    def test_orphaned_running_row_is_marked_failed(self):
        db = self.Session()
        try:
            old_stated = _naive_utc(self.now) - datetime.timedelta(hours=7)
            db.add(
                SyncLog(
                    sync_type="full",
                    status="running",
                    started_at=old_stated,
                )
            )
            db.commit()

            marked = scheduler_module.mark_orphaned_full_sync_rows_failed(db)

            self.assertEqual(marked, 1)
            log = db.query(SyncLog).one()
            self.assertEqual(log.status, "error")
            self.assertIsNotNone(log.finished_at)
            self.assertIn("interrupted", log.error_message.lower())
        finally:
            db.close()

    def test_recent_running_row_is_left_alone(self):
        db = self.Session()
        try:
            db.add(
                SyncLog(
                    sync_type="full",
                    status="running",
                    started_at=_naive_utc(self.now) - datetime.timedelta(hours=1),
                )
            )
            db.commit()

            marked = scheduler_module.mark_orphaned_full_sync_rows_failed(db)

            self.assertEqual(marked, 0)
            self.assertEqual(db.query(SyncLog).one().status, "running")
        finally:
            db.close()

    def test_old_running_price_row_is_not_touched(self):
        db = self.Session()
        try:
            db.add(
                SyncLog(
                    sync_type="price",
                    status="running",
                    started_at=_naive_utc(self.now) - datetime.timedelta(days=3),
                )
            )
            db.commit()

            marked = scheduler_module.mark_orphaned_full_sync_rows_failed(db)

            self.assertEqual(marked, 0)
            self.assertEqual(db.query(SyncLog).one().status, "running")
        finally:
            db.close()

    def test_legacy_null_sync_type_running_row_is_marked_failed(self):
        db = self.Session()
        try:
            db.add(
                SyncLog(
                    sync_type=None,
                    status="running",
                    started_at=_naive_utc(self.now) - datetime.timedelta(days=2),
                )
            )
            db.commit()

            marked = scheduler_module.mark_orphaned_full_sync_rows_failed(db)

            self.assertEqual(marked, 1)
            self.assertEqual(db.query(SyncLog).one().status, "error")
        finally:
            db.close()

    def test_orphan_cleanup_makes_the_overlap_guard_permissive(self):
        # The startup cleanup must never block a sync: the row it fails is already
        # outside the overlap guard's window, and a fresh sync still runs.
        from services.sync_service import _full_sync_in_progress

        db = self.Session()
        try:
            db.add(
                SyncLog(
                    sync_type="full",
                    status="running",
                    started_at=_naive_utc(self.now) - datetime.timedelta(hours=7),
                )
            )
            db.commit()
            self.assertFalse(_full_sync_in_progress(db))

            scheduler_module.mark_orphaned_full_sync_rows_failed(db)

            self.assertFalse(_full_sync_in_progress(db))
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
