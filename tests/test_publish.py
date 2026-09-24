"""Publishing: overlap rejection, idempotent retries, concurrent publishes."""

from __future__ import annotations

from datetime import timedelta

import threading

import pytest

from app.errors import IdempotencyMismatchError, OverlapError
from app.services.matrix import publish_draft
from tests.conftest import RULE_ETL_BACKUP, RULE_GPU, parse_ts


def _publish_v2(client, effective_from, request_id=None, rules=None):
    if rules is not None:
        client.put("/matrix/draft", json={"rules": rules})
    payload = {"effective_from": effective_from.isoformat()}
    if request_id is not None:
        payload["request_id"] = request_id
    return client.post("/matrix/versions", json=payload)


def test_publish_creates_v2_and_closes_v1_window(client, clock):
    boundary = clock.now  # v1 starts at epoch, boundary == current time
    resp = _publish_v2(client, boundary, rules=[RULE_ETL_BACKUP])
    assert resp.status_code == 201, resp.text
    v2 = resp.json()
    assert v2["version_no"] == 2
    assert parse_ts(v2["effective_from"]) == clock.now
    assert v2["effective_to"] is None
    assert v2["request_id"] is None

    versions = client.get("/matrix/versions").json()
    assert len(versions) == 2
    v1 = next(v for v in versions if v["version_no"] == 1)
    assert parse_ts(v1["effective_to"]) == boundary
    assert len(v2["rules"]) == 1
    assert v2["rules"][0]["job_type_a"] == "backup"
    assert v2["rules"][0]["job_type_b"] == "etl"


def test_overlapping_equal_effective_from_is_rejected(client, clock):
    boundary = clock.now
    first = _publish_v2(client, boundary, request_id="pub-1", rules=[RULE_ETL_BACKUP])
    assert first.status_code == 201

    # Duplicate publish at the exact same boundary (different request id):
    # the windows would overlap on a shared point.
    client.put("/matrix/draft", json={"rules": [RULE_GPU]})
    second = client.post(
        "/matrix/versions",
        json={"effective_from": boundary.isoformat(), "request_id": "pub-2"},
    )
    assert second.status_code == 409
    body = second.json()["error"]
    assert body["code"] == "effective_window_overlap"
    assert body["detail"]["latest_version_no"] == 2


def test_effective_from_before_latest_is_rejected(client, clock):
    assert _publish_v2(client, clock.now, request_id="p", rules=[RULE_ETL_BACKUP]).status_code == 201

    # v3 becomes effective 10h from now; its window opens in the future.
    clock.advance(hours=2)
    boundary3 = clock.now + timedelta(hours=8)
    assert _publish_v2(client, boundary3, request_id="p3").status_code == 201

    # Trying to insert a version between v2 and v3 (5h ahead, still in the
    # future) would retroactively overlap v3's reserved window.
    client.put("/matrix/draft", json={"rules": []})
    middle = clock.now + timedelta(hours=5)
    resp = client.post("/matrix/versions", json={"effective_from": middle.isoformat()})
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "effective_window_overlap"


def test_past_effective_from_is_rejected(client, clock):
    past = clock.now - timedelta(seconds=1)
    resp = client.post("/matrix/versions", json={"effective_from": past.isoformat()})
    assert resp.status_code == 422
    clock.advance(hours=1)
    future = clock.now
    resp = _publish_v2(client, future, request_id="ok")
    assert resp.status_code == 201


def test_publish_retry_is_idempotent(client, clock):
    boundary = clock.now
    r1 = _publish_v2(client, boundary, request_id="pub-retry", rules=[RULE_ETL_BACKUP])
    assert r1.status_code == 201
    v2 = r1.json()

    # Exact retry of the same publish request (draft has since changed):
    # the request itself is identical, so it replays the original result.
    client.put("/matrix/draft", json={"rules": [RULE_GPU]})
    r2 = client.post(
        "/matrix/versions",
        json={"effective_from": boundary.isoformat(), "request_id": "pub-retry"},
    )
    assert r2.status_code == 200
    assert r2.json()["id"] == v2["id"]
    assert r2.json()["version_no"] == 2
    assert r2.json()["rules_hash"] == v2["rules_hash"]
    # Only v1 + one v2 exist; the retry created nothing.
    assert len(client.get("/matrix/versions").json()) == 2


def test_same_request_id_different_payload_rejected(client, clock):
    boundary = clock.now
    r1 = _publish_v2(client, boundary, request_id="same-key", rules=[RULE_ETL_BACKUP])
    assert r1.status_code == 201

    clock.advance(hours=1)
    r2 = client.post(
        "/matrix/versions",
        json={"effective_from": clock.now.isoformat(), "request_id": "same-key"},
    )
    assert r2.status_code == 409
    assert r2.json()["error"]["code"] == "idempotency_mismatch"
    assert len(client.get("/matrix/versions").json()) == 2


def test_concurrent_publish_only_one_wins(app, clock):
    boundary = clock.now
    errors: list[Exception] = []
    results: list = []

    def worker():
        try:
            with app.state.session_factory() as session:
                version, _already = publish_draft(
                    session,
                    clock,
                    effective_from=boundary,
                    actor=f"worker-{threading.get_ident()}",
                    request_id=None,
                )
                results.append(version.version_no)
        except OverlapError as exc:
            errors.append(exc)
        except Exception as exc:  # pragma: no cover - surfaces unexpected races
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(results) == 1, f"expected exactly one winner, got {results}, errors={errors}"
    assert results == [2]
    assert len(errors) == 4
    assert all(isinstance(e, OverlapError) for e in errors)
    with app.state.session_factory() as session:
        from app.models import MatrixVersion

        count = len(session.query(MatrixVersion).all())
        assert count == 2  # baseline v1 + exactly one v2


def test_concurrent_publish_same_request_id_collapses(app, clock):
    boundary = clock.now
    errors: list[Exception] = []
    results: list = []

    def worker():
        try:
            with app.state.session_factory() as session:
                version, already = publish_draft(
                    session, clock, effective_from=boundary, actor="w", request_id="race-key"
                )
                results.append((version.id, already))
        except Exception as exc:  # pragma: no cover
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == []
    assert len(results) == 5
    assert len({r[0] for r in results}) == 1
    with app.state.session_factory() as session:
        from app.models import MatrixVersion

        count = len(session.query(MatrixVersion).all())
        assert count == 2  # baseline + one v2


def test_service_level_overlap_errors_are_specific(app, clock):
    with app.state.session_factory() as session:
        publish_draft(session, clock, effective_from=clock.now, actor="a", request_id="x")
    with app.state.session_factory() as session:
        with pytest.raises(OverlapError):
            publish_draft(session, clock, effective_from=clock.now, actor="b", request_id="y")
    with app.state.session_factory() as session:
        clock.advance(hours=1)
        with pytest.raises(IdempotencyMismatchError):
            publish_draft(session, clock, effective_from=clock.now, actor="c", request_id="x")
