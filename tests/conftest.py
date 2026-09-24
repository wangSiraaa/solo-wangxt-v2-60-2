"""Shared fixtures: real file-backed database, controllable clock, app factory."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.clock import Clock
from app.db import create_app_engine, make_session_factory
from app.main import create_app
from app.models import Base, LegacyMatrixRule


class FakeClock(Clock):
    """Deterministic clock; tests advance it explicitly."""

    def __init__(self, start: datetime | None = None):
        self.now = start or datetime(2026, 1, 1, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **kwargs) -> datetime:
        self.now = self.now + timedelta(**kwargs)
        return self.now


@pytest.fixture()
def db_path(tmp_path):
    return tmp_path / "test.db"


@pytest.fixture()
def clock():
    return FakeClock()


@pytest.fixture()
def make_app(db_path, clock):
    """Factory: optionally seed legacy rows, then build the app on a real DB file."""

    def _make(legacy_rules: list[dict] | None = None, app_clock: Clock | None = None):
        url = f"sqlite:///{db_path}"
        if legacy_rules is not None:
            engine = create_app_engine(url)
            Base.metadata.create_all(engine)
            factory = make_session_factory(engine)
            with factory() as session:
                for rule in legacy_rules:
                    session.add(LegacyMatrixRule(**rule))
                session.commit()
            engine.dispose()
        return create_app(url, clock=app_clock or clock)

    return _make


@pytest.fixture()
def app(make_app):
    return make_app(legacy_rules=[])


@pytest.fixture()
def client(app):
    with TestClient(app) as c:
        yield c


RULE_ETL_BACKUP = {
    "job_type_a": "etl",
    "job_type_b": "backup",
    "resources": [],
    "description": "ETL and full backup must not overlap",
}

RULE_GPU = {
    "job_type_a": "train",
    "job_type_b": "render",
    "resources": ["gpu-0"],
    "description": "training and rendering share gpu-0",
}


def parse_ts(value: str) -> datetime:
    """Parse an API timestamp (UTC offsets may be rendered as 'Z')."""

    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
