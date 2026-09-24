"""OpenAPI contract surface and query endpoints."""

from __future__ import annotations


def test_openapi_contains_all_endpoints(client):
    spec = client.get("/openapi.json").json()
    assert spec["info"]["title"] == "Mutex Job Matrix Service"
    paths = spec["paths"]
    expected = {
        "/matrix/draft": {"get", "put"},
        "/matrix/versions": {"get", "post"},
        "/matrix/versions/effective": {"get"},
        "/matrix/versions/{version_no}": {"get"},
        "/jobs/schedule": {"post"},
        "/jobs/{job_id}/start": {"post"},
        "/decisions/evaluate": {"post"},
        "/decisions": {"get"},
        "/decisions/{decision_id}": {"get"},
        "/decisions/{decision_id}/replay": {"post"},
        "/health": {"get"},
    }
    for path, methods in expected.items():
        assert path in paths, f"{path} missing from OpenAPI"
        assert methods.issubset(paths[path].keys()), f"{path}: {methods} vs {paths[path].keys()}"


def test_openapi_documents_idempotent_replay_responses(client):
    spec = client.get("/openapi.json").json()
    publish_op = spec["paths"]["/matrix/versions"]["post"]
    assert "200" in publish_op["responses"] and "201" in publish_op["responses"]
    schedule_op = spec["paths"]["/jobs/schedule"]["post"]
    assert "200" in schedule_op["responses"] and "201" in schedule_op["responses"]
    # Snapshot fields are part of the decision contract.
    decision_props = spec["components"]["schemas"]["DecisionOut"]["properties"]
    for field in (
        "matrix_version_no",
        "matrix_rules_snapshot",
        "matrix_rules_hash",
        "conflicts",
        "reason",
        "frozen_context",
    ):
        assert field in decision_props


def test_swagger_ui_available(client):
    resp = client.get("/docs")
    assert resp.status_code == 200


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_version_detail_and_404(client):
    assert client.get("/matrix/versions/1").json()["version_no"] == 1
    resp = client.get("/matrix/versions/99")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "not_found"


def test_decision_listing_and_evaluate_query(client, clock):
    from datetime import timedelta

    payload = {
        "job_type": "etl",
        "planned_start": clock.now.isoformat(),
        "planned_end": (clock.now + timedelta(hours=2)).isoformat(),
    }
    ev = client.post("/decisions/evaluate", json=payload)
    assert ev.status_code == 200
    body = ev.json()
    assert body["decision_kind"] == "evaluate"
    assert body["status"] == "accepted"
    assert body["matrix_version_no"] == 1
    assert body["conflicts"] == []

    # Dry run is side-effect free: nothing is recorded.
    assert client.get("/decisions").json() == []

    assert client.get("/decisions/does-not-exist").status_code == 404
