"""Fail-fast, idempotent physical-layout schema upgrade (never rewrites inventory)."""
from sqlalchemy import inspect, text


LAYOUT_CHECK = """(
    (layout_pages IS NULL AND layout_rows IS NULL AND layout_columns IS NULL) OR
    (layout_pages IS NOT NULL AND layout_rows IS NOT NULL AND layout_columns IS NOT NULL
     AND layout_pages BETWEEN 1 AND 500 AND layout_rows = 3 AND layout_columns IN (3, 4)
     AND COALESCE(binder_type, 'collection') = 'collection')
)"""

# Cross-table rules cannot be expressed as CHECK constraints. Deferred validation
# permits atomic printing corrections and merges while rejecting invalid final
# states, including writes made outside the placement endpoints.
INVALID_PLACEMENT = """
SELECT p.id FROM binder_placements p
LEFT JOIN binders b ON b.id = p.binder_id
LEFT JOIN binder_cards bc ON bc.id = p.binder_card_id
LEFT JOIN collection c ON c.id = bc.collection_item_id
WHERE (b.id IS NULL OR b.user_id IS NULL OR bc.id IS NULL OR c.id IS NULL
   OR bc.binder_id <> p.binder_id
   OR c.user_id IS DISTINCT FROM b.user_id
   OR c.card_id IS DISTINCT FROM bc.card_id
   OR c.quantity IS NULL OR c.quantity < 1
   OR COALESCE(b.binder_type, 'collection') <> 'collection'
   OR b.layout_pages IS NULL OR p.page > b.layout_pages
   OR p.slot > b.layout_rows * b.layout_columns
   OR (SELECT COUNT(*) FROM binder_placements q WHERE q.binder_card_id = bc.id)
      > COALESCE(bc.required_quantity, 1)
   OR (SELECT COALESCE(SUM(COALESCE(a.required_quantity, 1)), 0)
       FROM binder_cards a JOIN binders ab ON ab.id = a.binder_id
       WHERE a.collection_item_id = c.id AND ab.user_id = c.user_id
         AND COALESCE(ab.binder_type, 'collection') IN ('collection', 'physical_deck')) > c.quantity)
"""


def migrate_binder_layout_schema(target_engine):
    from models import BinderPlacement

    dialect = target_engine.dialect.name
    if dialect not in {"postgresql", "sqlite"}:
        raise RuntimeError("Physical binder layouts require PostgreSQL or SQLite")
    with target_engine.begin() as conn:
        existing = {col["name"] for col in inspect(conn).get_columns("binders")}
        for name, definition in {
            "layout_pages": "INTEGER",
            "layout_rows": "INTEGER",
            "layout_columns": "INTEGER",
            "layout_revision": "INTEGER NOT NULL DEFAULT 0",
            "layout_undo": "JSON",
        }.items():
            if name not in existing:
                conn.execute(text(f"ALTER TABLE binders ADD COLUMN {name} {definition}"))
        BinderPlacement.__table__.create(conn, checkfirst=True)
        inspector = inspect(conn)
        checks = {c["name"] for c in inspector.get_check_constraints("binder_placements")}
        unique = {tuple(c["column_names"]) for c in inspector.get_unique_constraints("binder_placements")}
        references = {(tuple(fk["constrained_columns"]), fk["referred_table"], tuple(fk["referred_columns"]))
                      for fk in inspector.get_foreign_keys("binder_placements")}
        if ("ck_binder_placement_position" not in checks
                or ("binder_id", "page", "slot") not in unique
                or not {(("binder_id",), "binders", ("id",)), (("binder_card_id",), "binder_cards", ("id",))} <= references):
            raise RuntimeError("Physical binder placement constraints are missing; repair before starting")
        if dialect == "postgresql":
            checks = {c["name"] for c in inspect(conn).get_check_constraints("binders")}
            if "ck_binders_layout" not in checks:
                conn.execute(text(f"ALTER TABLE binders ADD CONSTRAINT ck_binders_layout CHECK {LAYOUT_CHECK}"))
            conn.execute(text(f"""
                CREATE OR REPLACE FUNCTION validate_binder_placements() RETURNS trigger AS $$
                DECLARE affected_entries integer[];
                BEGIN
                    -- Deletes only reduce placement counts; foreign keys already
                    -- prevent deletion of a still-occupied parent. Scope all
                    -- other checks to the changed memberships, not every user.
                    IF TG_OP = 'DELETE' THEN RETURN NULL; END IF;
                    IF TG_TABLE_NAME = 'binder_placements' THEN
                        affected_entries := ARRAY[NEW.binder_card_id];
                    ELSIF TG_TABLE_NAME = 'binder_cards' THEN
                        SELECT array_agg(id) INTO affected_entries FROM binder_cards
                        WHERE id = NEW.id OR collection_item_id = NEW.collection_item_id;
                    ELSIF TG_TABLE_NAME = 'binders' THEN
                        SELECT array_agg(id) INTO affected_entries FROM binder_cards WHERE binder_id = NEW.id;
                    ELSE
                        SELECT array_agg(id) INTO affected_entries FROM binder_cards WHERE collection_item_id = NEW.id;
                    END IF;
                    IF EXISTS ({INVALID_PLACEMENT} AND p.binder_card_id = ANY(affected_entries)) THEN
                        RAISE EXCEPTION 'Physical binder placement integrity violation'
                            USING ERRCODE = '23514';
                    END IF;
                    RETURN NULL;
                END;
                $$ LANGUAGE plpgsql
            """))
            for table in ("binder_placements", "binder_cards", "binders", "collection"):
                trigger = f"ck_{table}_placements"
                conn.execute(text(f"DROP TRIGGER IF EXISTS {trigger} ON {table}"))
                conn.execute(text(f"""
                    CREATE CONSTRAINT TRIGGER {trigger}
                    AFTER INSERT OR UPDATE OR DELETE ON {table}
                    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
                    EXECUTE FUNCTION validate_binder_placements()
                """))
            # Serialize direct placement writes with the same user allocation
            # lock used by every API allocation workflow, before checking counts.
            conn.execute(text("""
                CREATE OR REPLACE FUNCTION lock_binder_placement_owner() RETURNS trigger AS $$
                DECLARE owner_id integer;
                BEGIN
                    SELECT user_id INTO owner_id FROM binders
                    WHERE id = NEW.binder_id;
                    PERFORM id FROM users WHERE id = owner_id FOR UPDATE;
                    RETURN NEW;
                END;
                $$ LANGUAGE plpgsql
            """))
            conn.execute(text("DROP TRIGGER IF EXISTS lock_binder_placement_owner ON binder_placements"))
            conn.execute(text("""
                CREATE TRIGGER lock_binder_placement_owner BEFORE INSERT OR UPDATE ON binder_placements
                FOR EACH ROW EXECUTE FUNCTION lock_binder_placement_owner()
            """))
            conn.execute(text("""
                CREATE OR REPLACE FUNCTION invalidate_binder_layout_undo() RETURNS trigger AS $$
                BEGIN
                    IF TG_OP <> 'INSERT' THEN
                        UPDATE binders SET layout_revision = layout_revision + 1, layout_undo = NULL
                        WHERE id = OLD.binder_id AND (layout_pages IS NOT NULL OR layout_undo IS NOT NULL);
                    END IF;
                    IF TG_OP <> 'DELETE' THEN
                        UPDATE binders SET layout_revision = layout_revision + 1, layout_undo = NULL
                        WHERE id = NEW.binder_id AND (layout_pages IS NOT NULL OR layout_undo IS NOT NULL);
                    END IF;
                    RETURN NULL;
                END;
                $$ LANGUAGE plpgsql
            """))
            for table in ("binder_placements", "binder_cards"):
                trigger = f"invalidate_{table}_layout_undo"
                conn.execute(text(f"DROP TRIGGER IF EXISTS {trigger} ON {table}"))
                conn.execute(text(f"""
                    CREATE TRIGGER {trigger} AFTER INSERT OR UPDATE OR DELETE ON {table}
                    FOR EACH ROW EXECUTE FUNCTION invalidate_binder_layout_undo()
                """))
            if conn.execute(text(f"SELECT EXISTS ({INVALID_PLACEMENT})")).scalar():
                raise RuntimeError("Invalid physical binder placements; repair before starting")
        # SQLite is the lightweight unit-test backend; PostgreSQL integration
        # tests exercise the deferred cross-table and concurrent-write guarantees.
        columns = {c["name"] for c in inspect(conn).get_columns("binder_placements")}
        if columns != {"id", "binder_id", "binder_card_id", "page", "slot"}:
            raise RuntimeError("Unexpected physical binder placement schema")
