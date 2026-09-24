"""Frozen decisions: v1 replay, v2 for new decisions, boundary selection, restart review."""

from __future__ import annotations

from datetime import timedelta

from fastapi.testclient import TestClient

from tests.conftest import RULE_ETL_BACKUP, RULE_GPU, parse_ts


def _window(clock, minutes=(0, 60)):
    start = clock.now + timedelta(minutes=minutes[0])
    end = clock.now + timedelta(minutes=minutes[1])
    return start.isoformat(), end.isoformat()


def _schedule(client, job_type, clock, resources=None, request_id=None):
    start, end = _window(clock)
    payload = {
        "job_type": job_type,
        "resources": resources or [],
        "planned_start": start,
        "planned_end": end,
    }
    if request_id is not None:
        payload["request_id"] = request_id
    return client.post("/jobs/schedule", json=payload)


# ---------------------------------------------------------------------------
# Legacy plans always replay against v1
# ---------------------------------------------------------------------------

def test_legacy_plan_always_replays_against_v1(make_app, clock):
    # v1 (from migration) forbids ETL <-> backup overlap.
    app = make_app(
        legacy_rules=[
            {
                "job_type_a": "etl",
                "job_type_b": "backup",
                "resources": [],
                "description": "v1 legacy rule",
            }
        ]
    )
    with TestClient(app) as c:
        # A plan accepted under v1: an ETL job.
        ok = _schedule(c, "etl", clock, request_id="etl-1")
        assert ok.status_code == 201, ok.text
        assert ok.json()["decision"]["matrix_version_no"] == 1
        etl_job = ok.json()["job"]

        # Its conflicting counterpart is rejected under v1.
        blocked = _schedule(c, "backup", clock)
        assert blocked.status_code == 201
        d1 = blocked.json()["decision"]
        assert d1["status"] == "rejected"
        assert d1["matrix_version_no"] == 1
        assert d1["conflicts"][0]["conflicting_job_id"] == etl_job["id"]
        assert "mutually exclusive" in d1["reason"]
        legacy_decision_id = d1["id"]

    # Publish v2 which *removes* the ETL/backup rule (and adds gpu rule).
    clock.advance(hours=1)
    app2 = make_app(legacy_rules=None, app_clock=clock)
    with TestClient(app2) as c2:
        c2.put("/matrix/draft", json={"rules": [RULE_GPU]})
        pub = c2.post("/matrix/versions", json={"effective_from": clock.now.isoformat()})
        assert pub.status_code == 201

        # Restart (new app instance, same DB file) and replay the old decision.
    app3 = make_app(legacy_rules=None, app_clock=clock)
    with TestClient(app3) as c3:
        replay = c3.post(f"/decisions/{legacy_decision_id}/replay").json()
        assert replay["matrix_version_no"] == 1
        assert replay["original_status"] == "rejected"
        assert replay["replayed_status"] == "rejected"
        assert replay["matches_original"] is True
        assert replay["snapshot_intact"] is True

        # Even though the *current* matrix allows it, the historical receipt
        # still says rejected and cites the v1 ETL/backup rule.
        old = c3.get(f"/decisions/{legacy_decision_id}").json()
        assert old["status"] == "rejected"
        assert old["matrix_version_no"] == 1
        pair = {
            old["matrix_rules_snapshot"][0]["job_type_a"],
            old["matrix_rules_snapshot"][0]["job_type_b"],
        }
        assert pair == {"backup", "etl"}

        # The accepted legacy plan is still present and still scheduled.
        plan = c3.get("/decisions", params={"job_id": etl_job["id"]}).json()
        assert any(d["matrix_version_no"] == 1 and d["status"] == "accepted" for d in plan)


# ---------------------------------------------------------------------------
# After v2 is published, new plans are judged by v2
# ---------------------------------------------------------------------------

def test_new_plans_after_v2_use_v2(make_app, clock):
    app = make_app(legacy_rules=[RULE_ETL_BACKUP])
    with TestClient(app) as c:
        # Pre-publish: ETL/backup conflict under v1.
        assert _schedule(c, "etl", clock).json()["decision"]["matrix_version_no"] == 1
        assert _schedule(c, "backup", clock).json()["decision"]["status"] == "rejected"

    clock.advance(hours=1)
    boundary = clock.now
    with TestClient(make_app(legacy_rules=None, app_clock=clock)) as c2:
        # v2: replace ETL/backup rule with GPU rule.
        c2.put("/matrix/draft", json={"rules": [RULE_GPU]})
        r = c2.post("/matrix/versions", json={"effective_from": boundary.isoformat()})
        assert r.status_code == 201

        # ETL + backup now coexist (rule removed in v2).
        etl = _schedule(c2, "etl", clock, resources=["db"])
        backup = _schedule(c2, "backup", clock, resources=["tape"])
        assert etl.json()["decision"]["matrix_version_no"] == 2
        assert backup.json()["decision"]["status"] == "accepted"
        assert backup.json()["decision"]["matrix_version_no"] == 2

        # But train/render on gpu-0 conflict under v2.
        train = _schedule(c2, "train", clock, resources=["gpu-0"], request_id="t1")
        render = _schedule(c2, "render", clock, resources=["gpu-0"])
        assert train.json()["decision"]["status"] == "accepted"
        d = render.json()["decision"]
        assert d["status"] == "rejected"
        assert d["matrix_version_no"] == 2
        assert d["conflicts"][0]["conflicting_job_id"] == train.json()["job"]["id"]
        assert "gpu-0" in d["reason"] or "gpu-0" in d["conflicts"][0]["basis"]

        # train/render without gpu-0 do NOT conflict (resource-scoped rule).
        cpu_train = _schedule(c2, "train", clock, resources=["cpu-7"])
        assert cpu_train.json()["decision"]["status"] == "accepted"


# ---------------------------------------------------------------------------
# Cross-effective-boundary version selection
# ---------------------------------------------------------------------------

def test_effective_boundary_selection_half_open(make_app, clock):
    app = make_app(legacy_rules=[RULE_ETL_BACKUP])
    with TestClient(app) as c:
        clock.advance(hours=1)
        boundary = clock.now
        c.put("/matrix/draft", json={"rules": [RULE_GPU]})
        c.post("/matrix/versions", json={"effective_from": boundary.isoformat()})

        def version_no(instant):
            r = c.get("/matrix/versions/effective", params={"at": instant.isoformat()})
            assert r.status_code == 200, r.text
            return r.json()["version_no"]

        # Window is [effective_from, ...): the exact boundary selects v2,
        # one microsecond before selects v1.
        assert version_no(boundary - timedelta(microseconds=1)) == 1
        assert version_no(boundary) == 2
        assert version_no(boundary + timedelta(days=365)) == 2

        # v1 still reachable at any pre-boundary instant.
        assert version_no(clock.now - timedelta(days=100000)) == 1

        versions = c.get("/matrix/versions").json()
        v1, v2 = versions
        assert parse_ts(v1["effective_to"]) == boundary
        assert parse_ts(v2["effective_from"]) == boundary
        assert v2["effective_to"] is None


def test_decisions_straddling_boundary_freeze_distinct_versions(make_app, clock):
    app = make_app(legacy_rules=[RULE_ETL_BACKUP])
    with TestClient(app) as c:
        # Accepted under v1 before the boundary.
        etl = _schedule(c, "etl", clock, request_id="etl-pre")
        assert etl.json()["decision"]["matrix_version_no"] == 1

        clock.advance(hours=1)
        boundary = clock.now
        c.put("/matrix/draft", json={"rules": []})
        c.post("/matrix/versions", json={"effective_from": boundary.isoformat()})

        # A start decision after the boundary evaluates against v2 (no rules):
        # the job starts even though it was scheduled under v1.
        job_id = etl.json()["job"]["id"]
        started = c.post(f"/jobs/{job_id}/start")
        assert started.status_code == 200, started.text
        sd = started.json()["decision"]
        assert sd["decision_kind"] == "start"
        assert sd["matrix_version_no"] == 2
        assert sd["status"] == "accepted"
        assert started.json()["job"]["status"] == "running"

        # Schedule decision is immutable at v1; start decision frozen at v2.
        history = c.get("/decisions", params={"job_id": job_id}).json()
        kinds = {(d["decision_kind"], d["matrix_version_no"]) for d in history}
        assert ("schedule", 1) in kinds
        assert ("start", 2) in kinds

        # Start decisions cannot be rewritten.
        again = c.post(f"/jobs/{job_id}/start")
        assert again.status_code == 409


# ---------------------------------------------------------------------------
# Restart: historical conflict reasons and version snapshots remain reviewable
# ---------------------------------------------------------------------------

def test_restart_preserves_snapshots_and_reasons(make_app, clock):
    app = make_app(legacy_rules=[RULE_ETL_BACKUP])
    with TestClient(app) as c:
        c.post(
            "/jobs/schedule",
            json={
                "job_type": "etl",
                "resources": [],
                "planned_start": clock.now.isoformat(),
                "planned_end": (clock.now + timedelta(hours=1)).isoformat(),
                "request_id": "restart-etl",
            },
        )
        rejected = c.post(
            "/jobs/schedule",
            json={
                "job_type": "backup",
                "resources": [],
                "planned_start": clock.now.isoformat(),
                "planned_end": (clock.now + timedelta(hours=1)).isoformat(),
            },
        ).json()
        decision_id = rejected["decision"]["id"]
        original_reason = rejected["decision"]["reason"]
        assert rejected["decision"]["status"] == "rejected"

    # Simulate restart with a fresh app instance against the same file.
    restarted = make_app(legacy_rules=None)
    with TestClient(restarted) as rc:
        fetched = rc.get(f"/decisions/{decision_id}").json()
        assert fetched["reason"] == original_reason
        assert fetched["matrix_version_no"] == 1
        assert fetched["matrix_rules_snapshot"] == rejected["decision"]["matrix_rules_snapshot"]
        assert fetched["frozen_context"]["matrix_version_no"] == 1
        assert len(fetched["frozen_context"]["active_jobs"]) == 1

        replay = rc.post(f"/decisions/{decision_id}/replay").json()
        assert replay["matches_original"] is True
        assert replay["snapshot_intact"] is True
        assert replay["replayed_conflicts"] == fetched["conflicts"]


# ---------------------------------------------------------------------------
# Idempotent schedule retries
# ---------------------------------------------------------------------------

def test_schedule_retry_is_idempotent(client, clock):
    start, end = _window(clock)
    payload = {
        "job_type": "etl",
        "planned_start": start,
        "planned_end": end,
        "request_id": "sch-1",
    }
    r1 = client.post("/jobs/schedule", json=payload)
    assert r1.status_code == 201
    r2 = client.post("/jobs/schedule", json=payload)
    assert r2.status_code == 200
    assert r2.json()["replayed"] is True
    assert r2.json()["decision"]["id"] == r1.json()["decision"]["id"]
    assert r2.json()["job"]["id"] == r1.json()["job"]["id"]

    # A rejected request is also idempotent (v1 empty baseline -> nothing rejects,
    # so craft a duplicate-request scenario directly at service level).
    decisions = client.get("/decisions").json()
    assert len(decisions) == 1


def test_concurrent_schedule_same_request_id_converges(app, clock):
    """Racing retries of one schedule request must not create duplicates."""

    import threading

    from app.services.jobs import schedule_job

    start = clock.now
    end = clock.now + timedelta(hours=1)
    outcomes: list = []
    errors: list[Exception] = []

    def worker():
        try:
            with app.state.session_factory() as session:
                plan, decision, replayed = schedule_job(
                    session,
                    clock,
                    job_type="etl",
                    resources=[],
                    planned_start=start,
                    planned_end=end,
                    request_id="race-schedule",
                )
                outcomes.append((plan.id if plan else None, decision.id))
        except Exception as exc:  # pragma: no cover
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == []
    assert len(outcomes) == 5
    # Every racer observes the same single plan and decision.
    assert len({o[0] for o in outcomes}) == 1
    assert len({o[1] for o in outcomes}) == 1
    with app.state.session_factory() as session:
        from app.models import JobDecision, JobPlan

        assert len(session.query(JobPlan).all()) == 1
        assert len(session.query(JobDecision).all()) == 1


# ---------------------------------------------------------------------------
# Snapshot tamper detection
# ---------------------------------------------------------------------------

def test_replay_flags_tampered_snapshot(app, client, clock):
    from app.models import JobDecision

    # Record a decision, then corrupt its frozen snapshot directly in the DB.
    rejected = client.post(
        "/jobs/schedule",
        json={
            "job_type": "etl",
            "planned_start": clock.now.isoformat(),
            "planned_end": (clock.now + timedelta(hours=1)).isoformat(),
        },
    ).json()
    decision_id = rejected["decision"]["id"]

    with app.state.session_factory() as session:
        row = session.get(JobDecision, decision_id)
        original_hash = row.matrix_rules_hash
        row.matrix_rules_snapshot = [
            {"job_type_a": "changed", "job_type_b": "pair", "resources": [], "description": "tampered"}
        ]
        session.commit()

    replay = client.post(f"/decisions/{decision_id}/replay").json()
    assert replay["snapshot_intact"] is False
    assert replay["matrix_rules_hash"] == original_hash


def test_v2_conflict_replay_matches_frozen_v2_basis(make_app, clock):
    from tests.conftest import RULE_GPU

    with TestClient(make_app(legacy_rules=[RULE_GPU])) as c:
        c.post(
            "/jobs/schedule",
            json={
                "job_type": "train",
                "resources": ["gpu-0"],
                "planned_start": clock.now.isoformat(),
                "planned_end": (clock.now + timedelta(hours=1)).isoformat(),
                "request_id": "tr",
            },
        )
        rejected = c.post(
            "/jobs/schedule",
            json={
                "job_type": "render",
                "resources": ["gpu-0"],
                "planned_start": clock.now.isoformat(),
                "planned_end": (clock.now + timedelta(hours=1)).isoformat(),
            },
        ).json()
        d = rejected["decision"]
        assert d["matrix_version_no"] == 1  # v1 here is the GPU rule (migrated)

        replay = c.post(f"/decisions/{d['id']}/replay").json()
        assert replay["snapshot_intact"] is True
        assert replay["matches_original"] is True
        assert replay["replayed_status"] == "rejected"
        assert replay["replayed_conflicts"][0]["conflicting_job_type"] == "train"
