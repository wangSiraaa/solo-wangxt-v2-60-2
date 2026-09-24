"""Safe migration of pre-versioning matrix data into immutable baseline v1."""

from __future__ import annotations

from datetime import datetime, timezone

from app.clock import EPOCH_START


def test_legacy_rows_migrate_into_baseline_v1(make_app):
    app = make_app(
        legacy_rules=[
            {
                "job_type_a": "backup",
                "job_type_b": "etl",
                "resources": [],
                "description": "legacy pair",
            },
            {
                "job_type_a": "train",
                "job_type_b": "render",
                "resources": ["gpu-0"],
                "description": "",
            },
        ]
    )
    from fastapi.testclient import TestClient

    with TestClient(app) as c:
        versions = c.get("/matrix/versions").json()
        assert len(versions) == 1
        v1 = versions[0]
        assert v1["version_no"] == 1
        assert v1["source"] == "migration"
        assert v1["published_by"] == "migration"
        assert v1["effective_from"].startswith("0001-01-01")
        assert v1["effective_to"] is None
        # Rule content preserved (pair order normalized, semantics identical).
        pairs = {(r["job_type_a"], r["job_type_b"]) for r in v1["rules"]}
        assert pairs == {("backup", "etl"), ("render", "train")}

        # Draft is seeded from v1 so editing continues from current data.
        draft = c.get("/matrix/draft").json()
        assert len(draft["rules"]) == 2


def test_empty_legacy_still_creates_empty_baseline(app, client):
    versions = client.get("/matrix/versions").json()
    assert len(versions) == 1
    assert versions[0]["version_no"] == 1
    assert versions[0]["rules"] == []


def test_migration_is_idempotent_across_restarts(make_app, db_path):
    legacy = [{"job_type_a": "a", "job_type_b": "b", "resources": [], "description": ""}]
    app1 = make_app(legacy_rules=legacy)
    from fastapi.testclient import TestClient

    with TestClient(app1) as c1:
        v1_first = c1.get("/matrix/versions/1").json()

    # "Restart": a brand-new app instance on the same database file.
    app2 = make_app(legacy_rules=None)
    with TestClient(app2) as c2:
        versions = c2.get("/matrix/versions").json()
        assert len(versions) == 1
        v1_second = versions[0]
        assert v1_second["id"] == v1_first["id"]
        assert v1_second["rules_hash"] == v1_first["rules_hash"]
        assert v1_second["effective_from"] == v1_first["effective_from"]


def test_baseline_effective_from_is_epoch_start(app):
    with app.state.session_factory() as session:
        from app.services.matrix import get_version

        v1 = get_version(session, 1)
        assert v1.effective_from == EPOCH_START
        assert v1.effective_from.tzinfo is timezone.utc
        assert v1.effective_from <= datetime(2000, 1, 1, tzinfo=timezone.utc)
