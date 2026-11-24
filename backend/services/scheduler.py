from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger
from apscheduler.triggers.date import DateTrigger
import logging
import datetime

logger = logging.getLogger(__name__)
# Give the persistent scan queue a short recovery window without changing other jobs.
scheduler = BackgroundScheduler()
_SCAN_QUEUE_MISFIRE_GRACE_SECONDS = 60

_DEFAULT_FULL_SYNC_DAYS = 5
_DEFAULT_PRICE_SYNC_MINUTES = 30
_DEFAULT_ARTWORK_SWEEP_INTERVAL_HOURS = 6
_DEFAULT_ARTWORK_SWEEP_BATCH_SIZE = 40

# The first run after a process start is delayed slightly so startup work wins.
STARTUP_FULL_SYNC_DELAY = datetime.timedelta(minutes=1)
# A full sync takes ~20 minutes. Sleep/suspend and restarts must not turn an
# on-time run into a missed one, so a late dispatch may still start within an hour.
FULL_SYNC_MISFIRE_GRACE_SECONDS = 60 * 60
# A "running" full-sync row older than this was left behind by a previous
# process (crash, container recreate, deploy) and can no longer finish.
ORPHANED_FULL_SYNC_AFTER = datetime.timedelta(hours=6)
ARTWORK_SWEEP_STARTUP_DELAY = datetime.timedelta(minutes=3)


def _get_int_setting(key: str, default: int) -> int:
    """Read an integer setting from the DB, falling back to ``default``."""
    try:
        from database import SessionLocal
        from models import Setting
        with SessionLocal() as db:
            row = db.query(Setting).filter(Setting.key == key).first()
            if row:
                return int(row.value)
    except Exception:
        pass
    return default


def _get_full_sync_interval_days() -> int:
    """Read full sync interval from DB settings."""
    return _get_int_setting("full_sync_interval_days", _DEFAULT_FULL_SYNC_DAYS)


def _get_price_sync_interval_minutes() -> int:
    """Read price sync interval from DB settings."""
    return _get_int_setting("price_sync_interval_minutes", _DEFAULT_PRICE_SYNC_MINUTES)


def _get_artwork_sweep_interval_hours() -> int:
    """Read the artwork sweep interval from DB settings."""
    return _get_int_setting(
        "artwork_sweep_interval_hours", _DEFAULT_ARTWORK_SWEEP_INTERVAL_HOURS
    )


def _get_artwork_sweep_batch_size() -> int:
    """Read the per-sweep set limit from DB settings."""
    return _get_int_setting(
        "artwork_sweep_batch_size", _DEFAULT_ARTWORK_SWEEP_BATCH_SIZE
    )


def run_full_sync() -> dict:
    """Full sync job — syncs sets + cards + prices.

    This intentionally does not check the cadence: the manual /api/sync endpoint
    shares ``perform_full_sync`` and must always bypass the scheduler guard
    (only the overlap guard in ``sync_service`` applies to both).
    """
    from database import SessionLocal
    from services.sync_service import perform_full_sync

    db = SessionLocal()
    try:
        logger.info("Starting scheduled full sync...")
        result = perform_full_sync(db)
        logger.info("Scheduled full sync finished with status=%s", result.get("status"))
        return result
    except Exception as e:
        logger.error(f"Scheduled full sync failed: {e}")
        return {"status": "error", "error": str(e)}
    finally:
        db.close()


def _as_utc_naive(value: datetime.datetime) -> datetime.datetime:
    """Normalize a datetime (naive UTC or aware) to naive UTC for comparison."""
    if value.tzinfo is not None and value.utcoffset() is not None:
        return value.astimezone(datetime.timezone.utc).replace(tzinfo=None)
    return value


def _as_utc(value: datetime.datetime) -> datetime.datetime:
    """Attach UTC to a naive UTC datetime for APScheduler."""
    if value.tzinfo is not None and value.utcoffset() is not None:
        return value.astimezone(datetime.timezone.utc)
    return value.replace(tzinfo=datetime.timezone.utc)


def _full_sync_log_filter():
    """Match full-sync rows, including legacy rows that predate ``sync_type``."""
    from sqlalchemy import or_
    from models import SyncLog

    return or_(SyncLog.sync_type == "full", SyncLog.sync_type.is_(None))


def last_successful_full_sync_finished_at(db) -> datetime.datetime | None:
    """Return when the last successful full sync finished, or None if unknown."""
    from models import SyncLog

    row = db.query(SyncLog.finished_at).filter(
        SyncLog.status == "success",
        _full_sync_log_filter(),
        SyncLog.finished_at.isnot(None),
    ).order_by(SyncLog.finished_at.desc()).first()
    return row[0] if row else None


def next_full_sync_run_time(
    now_utc: datetime.datetime,
    interval_days: int,
    last_success_finished_at: datetime.datetime | None = None,
) -> datetime.datetime:
    """Compute the startup next-run time from the last successful full sync.

    A process restart must not postpone a due sync: the due time is always
    derived from persistent sync_log history, not from process start. With no
    successful history (fresh install, restored database) the sync runs soon
    after startup, which is also the first-boot behaviour.
    """
    interval = datetime.timedelta(days=max(1, int(interval_days)))
    earliest = now_utc + STARTUP_FULL_SYNC_DELAY
    if last_success_finished_at is None:
        return earliest

    due_at = _as_utc_naive(last_success_finished_at) + interval
    if due_at <= _as_utc_naive(now_utc):
        return earliest
    return _as_utc(due_at)


def run_scheduled_full_sync() -> dict:
    """Scheduler-only wrapper that enforces the DB-backed full-sync cadence.

    APScheduler replaces the trigger's next run on every process start, so the
    cadence has to be re-derived from the last successful sync here rather than
    trusted from process uptime. The manual admin endpoint calls
    ``perform_full_sync`` directly and keeps bypassing this guard.
    """
    from database import SessionLocal

    now_utc = datetime.datetime.now(datetime.timezone.utc)
    interval_days = max(1, _get_full_sync_interval_days())
    db = SessionLocal()
    try:
        last_success = last_successful_full_sync_finished_at(db)
    except Exception:
        logger.warning(
            "Could not read the last successful full sync; running the scheduled sync",
            exc_info=True,
        )
        last_success = None
    finally:
        db.close()

    last_success_naive = (
        _as_utc_naive(last_success) if last_success is not None else None
    )
    if last_success_naive is not None:
        due_at = last_success_naive + datetime.timedelta(days=interval_days)
        if due_at > _as_utc_naive(now_utc):
            reason = (
                f"last successful full sync finished at "
                f"{last_success_naive.strftime('%Y-%m-%dT%H:%M:%SZ')}; "
                f"next run not due before {due_at.strftime('%Y-%m-%dT%H:%M:%SZ')}"
            )
            logger.info("Scheduled full sync skipped: %s", reason)
            return {"status": "skipped", "reason": reason}

    return run_full_sync()


def mark_orphaned_full_sync_rows_failed(db, stale_after: datetime.timedelta | None = None) -> int:
    """Fail full-sync rows a previous process left in ``status='running'``.

    Startup calls this so an interrupted sync is recorded honestly. The overlap
    guard in ``services.sync_service`` already ignores rows older than one hour
    (``FULL_SYNC_STALE_AFTER``); failing these much older rows keeps the history
    accurate without ever making the guard more permissive.
    """
    from models import SyncLog

    stale_after = stale_after or ORPHANED_FULL_SYNC_AFTER
    now = datetime.datetime.utcnow()
    cutoff = now - stale_after
    rows = db.query(SyncLog).filter(
        SyncLog.status == "running",
        _full_sync_log_filter(),
        (SyncLog.started_at.is_(None)) | (SyncLog.started_at < cutoff),
    ).all()
    if not rows:
        return 0

    note = "Interrupted by a process restart before the sync finished."
    for row in rows:
        row.status = "error"
        row.finished_at = now
        row.error_message = f"{row.error_message}\n{note}" if row.error_message else note
    db.commit()
    logger.warning(
        "Marked %s orphaned full sync row(s) as failed: %s",
        len(rows),
        ", ".join(str(row.id) for row in rows),
    )
    return len(rows)


def run_artwork_sweep_job() -> dict:
    """Backfill card artwork TCGdex published after a card was first synced.

    ``services.artwork_backfill`` is imported inside the job body on purpose:
    the scheduler must stay importable even if that module is unavailable.
    """
    try:
        from services.artwork_backfill import run_artwork_sweep
    except Exception as exc:
        logger.warning("Artwork sweep unavailable: %s", exc)
        return {"status": "skipped", "reason": str(exc)}

    limit = _get_artwork_sweep_batch_size()
    try:
        result = run_artwork_sweep(limit=limit)
        logger.info(
            "Artwork sweep complete: sets_checked=%s cards_updated=%s sets_failed=%s remaining=%s (limit=%s)",
            result.get("sets_checked"),
            result.get("cards_updated"),
            result.get("sets_failed"),
            result.get("remaining"),
            limit,
        )
        return result
    except Exception as exc:
        logger.exception("Artwork sweep failed")
        return {"status": "error", "error": str(exc)}


def run_price_sync():
    """Price-only sync job."""
    from database import SessionLocal
    from services.sync_service import perform_price_sync

    db = SessionLocal()
    try:
        logger.info("Starting scheduled price sync...")
        perform_price_sync(db)
        logger.info("Scheduled price sync completed successfully")
    except Exception as e:
        logger.error(f"Scheduled price sync failed: {e}")
    finally:
        db.close()


_jp_price_sync_running = False


def is_jp_price_sync_running() -> bool:
    return _jp_price_sync_running


def run_jp_price_sync():
    """Suruga-ya JPY price sync for owned Japanese cards — personal, local-only feature.

    Self-guarding: the scheduler's own interval trigger and the manual
    /api/sync/prices/jp endpoint both call this same function, so a single
    flag here (checked before either caller starts real work) is enough to
    stop them racing and running the full sync twice concurrently.
    """
    global _jp_price_sync_running
    if _jp_price_sync_running:
        logger.info("Suruga-ya JP price sync already running, skipping")
        return

    import datetime as dt

    from database import SessionLocal
    from models import SyncLog
    from services.suruga_ya_pricing import sync_jp_prices_for_collection

    _jp_price_sync_running = True
    db = SessionLocal()
    log = SyncLog(started_at=dt.datetime.utcnow(), status="running", sync_type="jp_price")
    db.add(log)
    db.commit()
    try:
        logger.info("Starting scheduled Suruga-ya JP price sync...")
        result = sync_jp_prices_for_collection(db)
        log.status = "success"
        log.cards_updated = result["updated"]
        log.error_message = (
            f"attempted={result['attempted']} no_match={result['no_match']} failed={result['failed']}"
        )
        logger.info(
            "Scheduled JP price sync completed: attempted=%s updated=%s no_match=%s failed=%s",
            result["attempted"], result["updated"], result["no_match"], result["failed"],
        )
    except Exception as e:
        log.status = "error"
        log.error_message = str(e)
        logger.error(f"Scheduled JP price sync failed: {e}")
    finally:
        log.finished_at = dt.datetime.utcnow()
        db.commit()
        db.close()
        _jp_price_sync_running = False


def run_scan_queue_maintenance():
    """Recover, process, and expire persistent background scans."""
    import asyncio

    from database import SessionLocal
    from services.gemini_rate_limit import purge_stale_quota_states
    from services.provider_rate_limit import purge_stale_provider_limit_states
    from services.scan_queue import (
        drain_scan_queue,
        purge_expired_scan_jobs,
        recover_expired_leases,
    )
    from services.scan_storage import purge_orphaned_scan_directories

    db = SessionLocal()
    try:
        recovered = recover_expired_leases(db)
        removed = purge_expired_scan_jobs(db)
        orphans = purge_orphaned_scan_directories(db)
        stale_quotas = purge_stale_quota_states()
        stale_provider_limits = purge_stale_provider_limit_states()
        if recovered or removed or orphans or stale_quotas or stale_provider_limits:
            logger.info(
                "Scan queue maintenance recovered %s lease(s), expired %s job(s), "
                "removed %s orphaned upload directory/directories, and purged %s "
                "inactive Gemini quota state(s) and %s provider limit state(s)",
                recovered,
                removed,
                orphans,
                stale_quotas,
                stale_provider_limits,
            )
    except Exception:
        db.rollback()
        logger.exception("Scan queue recovery/expiry failed")
    finally:
        db.close()

    try:
        asyncio.run(drain_scan_queue(max_items=50))
    except Exception:
        logger.exception("Scan queue processing failed")


def run_pokedex_metadata_backfill():
    """One-time startup backfill for Pokédex mappings added to existing card rows."""
    from database import SessionLocal
    from services.pokedex_backfill import run_pokedex_metadata_backfill as run_backfill
    from services.pokedex_backfill import startup_pokedex_backfill_batch_delay_seconds
    from services.pokedex_backfill import startup_pokedex_backfill_batch_limit

    db = SessionLocal()
    try:
        logger.info("Starting one-time Pokédex metadata backfill...")
        result = run_backfill(
            db,
            batch_limit=startup_pokedex_backfill_batch_limit(),
            batch_delay_seconds=startup_pokedex_backfill_batch_delay_seconds(),
        )
        if result.get("skipped"):
            logger.info("Pokédex metadata backfill skipped: %s", result.get("reason"))
        elif result.get("completed"):
            logger.info(
                "Pokédex metadata backfill completed: attempted=%s updated=%s missing=%s failed=%s batches=%s",
                result["attempted"],
                result["updated"],
                result["missing"],
                result["failed"],
                result["batches"],
            )
        else:
            logger.warning(
                "Pokédex metadata backfill stopped before completion: attempted=%s updated=%s missing=%s failed=%s batches=%s",
                result["attempted"],
                result["updated"],
                result["missing"],
                result["failed"],
                result["batches"],
            )
    except Exception as e:
        logger.error("Pokédex metadata backfill failed: %s", e)
    finally:
        db.close()


# Keep legacy alias
def run_sync():
    """Legacy alias for run_full_sync."""
    run_full_sync()


def start_scheduler():
    """Start the background scheduler with separate full and small price sync jobs."""
    if not scheduler.running:
        now_utc = datetime.datetime.now(datetime.timezone.utc)

        from database import SessionLocal
        from services.pokedex_backfill import (
            missing_pokedex_metadata_count,
            pokedex_metadata_backfill_completed,
            startup_pokedex_backfill_enabled,
        )
        with SessionLocal() as db:
            try:
                mark_orphaned_full_sync_rows_failed(db)
            except Exception:
                logger.warning("Could not clear orphaned full sync rows", exc_info=True)
                try:
                    db.rollback()
                except Exception:
                    pass
            needs_pokedex_backfill = (
                startup_pokedex_backfill_enabled()
                and not pokedex_metadata_backfill_completed(db)
                and missing_pokedex_metadata_count(db) > 0
            )
            try:
                last_full_sync_success = last_successful_full_sync_finished_at(db)
            except Exception:
                logger.warning(
                    "Could not read the last successful full sync; scheduling from startup",
                    exc_info=True,
                )
                last_full_sync_success = None

        full_interval_days = max(1, _get_full_sync_interval_days())
        price_interval_minutes = _get_price_sync_interval_minutes()
        artwork_interval_hours = max(1, _get_artwork_sweep_interval_hours())

        # Job 1: Full sync (sets + cards + tracked prices). The cadence is
        # derived from the last successful run in sync_log so restarts cannot
        # postpone it indefinitely.
        full_next_run = next_full_sync_run_time(
            now_utc,
            full_interval_days,
            last_full_sync_success,
        )
        scheduler.add_job(
            run_scheduled_full_sync,
            trigger=IntervalTrigger(days=full_interval_days),
            id="full_sync_job",
            name="Pokemon TCG Full Sync",
            replace_existing=True,
            next_run_time=full_next_run,
            coalesce=True,
            max_instances=1,
            misfire_grace_time=FULL_SYNC_MISFIRE_GRACE_SECONDS,
        )

        # Recurring auto sync: small price sync.
        scheduler.add_job(
            run_price_sync,
            trigger=IntervalTrigger(minutes=price_interval_minutes),
            id="price_sync_job",
            name="Pokemon TCG Price Sync",
            replace_existing=True,
            next_run_time=now_utc + datetime.timedelta(minutes=price_interval_minutes),
        )

        # Suruga-ya JPY price sync for owned Japanese cards — personal, local-only.
        scheduler.add_job(
            run_jp_price_sync,
            trigger=IntervalTrigger(weeks=1),
            id="jp_price_sync_job",
            name="Suruga-ya JP Price Sync",
            replace_existing=True,
            next_run_time=now_utc + datetime.timedelta(minutes=5),
        )

        scheduler.add_job(
            run_scan_queue_maintenance,
            trigger=IntervalTrigger(minutes=1),
            id="scan_queue_maintenance_job",
            name="Persistent Scan Queue",
            replace_existing=True,
            next_run_time=now_utc + datetime.timedelta(seconds=45),
            misfire_grace_time=_SCAN_QUEUE_MISFIRE_GRACE_SECONDS,
            coalesce=True,
        )

        # Artwork sweep: recover artwork TCGdex publishes after a card was
        # synced. The job imports services.artwork_backfill lazily.
        scheduler.add_job(
            run_artwork_sweep_job,
            trigger=IntervalTrigger(hours=artwork_interval_hours),
            id="artwork_sweep_job",
            name="Card Artwork Sweep",
            replace_existing=True,
            next_run_time=now_utc + ARTWORK_SWEEP_STARTUP_DELAY,
            coalesce=True,
            max_instances=1,
            misfire_grace_time=FULL_SYNC_MISFIRE_GRACE_SECONDS,
        )

        if needs_pokedex_backfill:
            scheduler.add_job(
                run_pokedex_metadata_backfill,
                trigger=DateTrigger(run_date=now_utc + datetime.timedelta(seconds=30)),
                id="pokedex_metadata_backfill_job",
                name="One-time Pokédex Metadata Backfill",
                replace_existing=True,
            )

        scheduler.start()
        logger.info(
            f"Scheduler started — full sync every {full_interval_days} days "
            f"(next run {full_next_run.isoformat()}), "
            f"small price sync every {price_interval_minutes} minutes, "
            f"artwork sweep every {artwork_interval_hours} hours"
            f"{', one-time Pokédex metadata backfill scheduled' if needs_pokedex_backfill else ''}"
        )
    else:
        logger.info("Scheduler already running")


def stop_scheduler():
    """Stop the background scheduler."""
    if scheduler.running:
        scheduler.shutdown()
        logger.info("Scheduler stopped")


def reschedule_full_sync(interval_days: int):
    """Reschedule the full sync job with a new interval."""
    if scheduler.running:
        scheduler.reschedule_job(
            "full_sync_job",
            trigger=IntervalTrigger(days=interval_days),
        )
        logger.info(f"Full sync rescheduled to every {interval_days} days")


def reschedule_price_sync(interval_minutes: int):
    """Reschedule the price sync job with a new interval."""
    if scheduler.running:
        scheduler.reschedule_job(
            "price_sync_job",
            trigger=IntervalTrigger(minutes=interval_minutes),
        )
        logger.info(f"Price sync rescheduled to every {interval_minutes} minutes")
