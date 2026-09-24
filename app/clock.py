"""UTC clock abstraction.

All timestamps in the system are timezone-aware UTC datetimes.  Services never
call ``datetime.now`` directly; they receive a :class:`Clock` so tests can
control "now" (e.g. to exercise cross-effective-boundary behaviour).
"""

from __future__ import annotations

from datetime import datetime, timezone


def utcnow() -> datetime:
    """Current time as an aware UTC datetime."""
    return datetime.now(timezone.utc)


class Clock:
    """Callable returning the current aware-UTC time.  Override in tests."""

    def __call__(self) -> datetime:
        return utcnow()


#: Effective-from used for the migrated baseline version (v1).  Using the
#: minimum representable UTC instant guarantees that every historical
#: decision timestamp falls inside the v1 window, so existing plans keep
#: replaying against v1 forever.
EPOCH_START = datetime(1, 1, 1, tzinfo=timezone.utc)
