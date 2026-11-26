"""The capture-lab routes opt out of the app-wide 60/minute default limit.

``SlowAPIMiddleware`` applies ``default_limits`` to every route whose handler is
not registered with ``limiter.exempt``. These tests pin both halves of that
behaviour: a capture-lab route survives a burst far above the limit, and an
ordinary route still answers 429 past 60 requests/minute. The negative control
removes one route's exemption to prove the exemption itself is what allows the
burst (not a failed route lookup, which slowapi also treats as exempt).
"""

import os
import tempfile
import types
import unittest
from unittest.mock import patch

try:
    from fastapi.testclient import TestClient

    import main
    from api import capture_lab_experiments, capture_lab_proposals, dev_capture_lab
    from api.auth import get_current_user
    from services.rate_limit import limiter

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

LAB_ROUTERS = (
    (dev_capture_lab.router, "/api/dev/capture-lab"),
    (capture_lab_proposals.router, "/api/capture-lab"),
    (capture_lab_experiments.router, "/api/capture-lab"),
) if DEPS_AVAILABLE else ()


@unittest.skipUnless(DEPS_AVAILABLE, "API dependencies are not installed")
class CaptureLabRateLimitExemptionTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.user = types.SimpleNamespace(id=5, username="rate-limit-probe")
        self.client = TestClient(main.app)
        main.app.dependency_overrides[get_current_user] = lambda: self.user
        limiter.reset()

    def tearDown(self):
        main.app.dependency_overrides.pop(get_current_user, None)
        self.client.close()
        self.temp_dir.cleanup()
        limiter.reset()

    def _enabled_env(self):
        return patch.dict(
            os.environ,
            {
                "CAPTURE_LAB_ENABLED": "true",
                "CAPTURE_LAB_DIR": self.temp_dir.name,
            },
        )

    def test_every_capture_lab_endpoint_is_registered_as_exempt(self):
        names = {
            f"{route.endpoint.__module__}.{route.endpoint.__name__}"
            for router, _prefix in LAB_ROUTERS
            for route in router.routes
        }
        self.assertTrue(names)
        self.assertEqual(names - limiter._exempt_routes, set())

    def test_capture_lab_burst_of_100_is_not_rate_limited(self):
        with self._enabled_env():
            statuses = [
                self.client.get("/api/capture-lab/experiments").status_code
                for _ in range(100)
            ]
        self.assertEqual(statuses, [200] * 100)

    def test_the_same_route_is_limited_once_its_exemption_is_removed(self):
        # Negative control: without the exemption the global default applies, so
        # the burst above cannot be passing because the handler was not found.
        name = "api.capture_lab_experiments.list_experiments"
        limiter._exempt_routes.discard(name)
        try:
            with self._enabled_env():
                statuses = [
                    self.client.get("/api/capture-lab/experiments").status_code
                    for _ in range(61)
                ]
        finally:
            limiter._exempt_routes.add(name)
        self.assertEqual(statuses[:60], [200] * 60)
        self.assertEqual(statuses[60], 429)

    def test_normal_route_still_returns_429_past_60_per_minute(self):
        statuses = [self.client.get("/api/health").status_code for _ in range(61)]
        self.assertEqual(statuses[:60], [200] * 60)
        self.assertEqual(statuses[60], 429)
