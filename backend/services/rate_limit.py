"""The app-wide SlowAPI limiter, in its own module.

``main.py`` attaches this instance to ``app.state.limiter`` and installs
``SlowAPIMiddleware``, which applies ``default_limits`` to every route. Routers
that need to opt out (the capture lab's polling pages) import this module
instead of ``main`` so there is no import cycle.

The 60/minute default is shipped product behaviour and stays unchanged; only
individually decorated routes are exempt.
"""

from slowapi import Limiter
from slowapi.util import get_remote_address

# Rate limiter: uses client IP, default 60 requests/minute
limiter = Limiter(key_func=get_remote_address, default_limits=["60/minute"])
