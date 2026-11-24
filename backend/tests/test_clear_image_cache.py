import unittest
from types import SimpleNamespace
from unittest.mock import patch

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from api.backup import clear_image_cache
    from database import Base
    from models import ImageCache

    DEPS = True
except ModuleNotFoundError:
    DEPS = False


@unittest.skipUnless(DEPS, "backend web/database dependencies are not installed")
class ClearImageCacheTests(unittest.TestCase):
    """Clearing the image cache must delete the persisted rows, not just a dir."""

    def setUp(self):
        self.engine = create_engine(
            "sqlite://",
            poolclass=StaticPool,
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine, autoflush=False)
        db = self.Session()
        try:
            db.add_all(
                [
                    ImageCache(image_key="card-a", data=b"a" * 10),
                    ImageCache(image_key="card-b", data=b"b" * 14),
                ]
            )
            db.commit()
        finally:
            db.close()

    def tearDown(self):
        self.engine.dispose()

    def test_admin_clear_deletes_rows_and_reports_counts(self):
        db = self.Session()
        try:
            with patch("api.backup.os.path.exists", return_value=False):
                result = clear_image_cache(
                    current_user=SimpleNamespace(role="admin"),
                    db=db,
                )

            self.assertEqual(result["deleted"], 2)
            self.assertEqual(result["bytes_freed"], 24)
            self.assertIn("2 cached image", result["message"])
            self.assertEqual(db.query(ImageCache).count(), 0)
        finally:
            db.close()

    def test_non_admin_is_rejected_without_deleting(self):
        db = self.Session()
        try:
            with patch("api.backup.os.path.exists") as path_exists:
                with self.assertRaises(HTTPException) as raised:
                    clear_image_cache(
                        current_user=SimpleNamespace(role="user"),
                        db=db,
                    )

            self.assertEqual(raised.exception.status_code, 403)
            path_exists.assert_not_called()
            self.assertEqual(db.query(ImageCache).count(), 2)
        finally:
            db.close()

    def test_unknown_size_is_reported_as_null(self):
        db = self.Session()
        try:
            with patch("api.backup.os.path.exists", return_value=False), patch(
                "api.backup._image_cache_byte_size", return_value=None
            ):
                result = clear_image_cache(
                    current_user=SimpleNamespace(role="admin"),
                    db=db,
                )

            self.assertEqual(result["deleted"], 2)
            self.assertIsNone(result["bytes_freed"])
            self.assertEqual(db.query(ImageCache).count(), 0)
        finally:
            db.close()

    def test_legacy_image_directory_is_still_removed(self):
        db = self.Session()
        try:
            with patch("api.backup.os.path.exists", return_value=True) as path_exists, \
                    patch("shutil.rmtree") as rmtree, \
                    patch("api.backup.os.makedirs") as makedirs:
                result = clear_image_cache(
                    current_user=SimpleNamespace(role="admin"),
                    db=db,
                )

            path_exists.assert_called_once_with("/app/images")
            rmtree.assert_called_once_with("/app/images")
            makedirs.assert_called_once_with("/app/images", exist_ok=True)
            self.assertEqual(result["deleted"], 2)
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
