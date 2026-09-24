"""Job scheduling / starting decisions with frozen matrix snapshots."""

from __future__ import annotations

from datetime import datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.clock import Clock
from app.errors import ConflictError, NotFoundError, UnprocessableError
from app.models import JobDecision, JobPlan, new_id
from app.services import engine as engine_svc
from app.services.matrix import get_effective_version

ACTIVE_PLAN_STATUSES = ("scheduled", "running")


def _validate_window(planned_start: datetime, planned_end: datetime) -> None:
    if planned_start.tzinfo is None or planned_end.tzinfo is None:
        raise UnprocessableError("planned_start/planned_end must include a timezone")
    if planned_end <= planned_start:
        raise UnprocessableError("planned_end must be after planned_start")


def _active_plans(session: Session, exclude_job_id: str | None = None) -> list[engine_svc.JobFact]:
    stmt = sa.select(JobPlan).where(JobPlan.status.in_(ACTIVE_PLAN_STATUSES))
    if exclude_job_id:
        stmt = stmt.where(JobPlan.id != exclude_job_id)
    return [engine_svc.JobFact.from_row(row) for row in session.scalars(stmt).all()]


def _frozen_context(
    decided_at: datetime,
    version,
    active: list[engine_svc.JobFact],
) -> dict[str, Any]:
    return {
        "decided_at": decided_at.isoformat(timespec="microseconds"),
        "matrix_version_no": version.version_no,
        "matrix_effective_from": version.effective_from.isoformat(timespec="microseconds"),
        "matrix_effective_to": (
            version.effective_to.isoformat(timespec="microseconds")
            if version.effective_to
            else None
        ),
        "matrix_rules_hash": version.rules_hash,
        "active_jobs": [
            {
                "job_id": j.job_id,
                "job_type": j.job_type,
                "resources": sorted(j.resources),
                "planned_start": j.planned_start.isoformat(timespec="microseconds"),
                "planned_end": j.planned_end.isoformat(timespec="microseconds"),
            }
            for j in sorted(active, key=lambda j: j.job_id)
        ],
    }


def _record_decision(
    session: Session,
    *,
    decision_kind: str,
    decided_at: datetime,
    version,
    job: JobPlan | None,
    job_type: str,
    resources: list[str],
    planned_start: datetime,
    planned_end: datetime,
    conflicts: list[dict[str, Any]],
    active: list[engine_svc.JobFact],
    request_id: str | None,
) -> JobDecision:
    status = "rejected" if conflicts else "accepted"
    if conflicts:
        first = conflicts[0]["rule"]
        reason = (
            f"rejected by matrix v{version.version_no}: {len(conflicts)} conflict(s); "
            f"first: {first['job_type_a']} mutually exclusive with {first['job_type_b']}"
        )
    else:
        reason = f"accepted under matrix v{version.version_no}: no conflicts"
    decision = JobDecision(
        decision_kind=decision_kind,
        decided_at=decided_at,
        matrix_version_id=version.id,
        matrix_version_no=version.version_no,
        matrix_rules_hash=version.rules_hash,
        matrix_rules_snapshot=list(version.rules),
        job_id=job.id if job else None,
        job_type=job_type,
        resources=list(resources),
        planned_start=planned_start,
        planned_end=planned_end,
        status=status,
        conflicts=conflicts,
        reason=reason,
        frozen_context=_frozen_context(decided_at, version, active),
        request_id=request_id,
    )
    session.add(decision)
    return decision


def schedule_job(
    session: Session,
    clock: Clock,
    *,
    job_type: str,
    resources: list[str],
    planned_start: datetime,
    planned_end: datetime,
    request_id: str | None,
) -> tuple[JobPlan | None, JobDecision, bool]:
    """Evaluate and (if accepted) register a job plan.

    The matrix version effective at the decision instant is frozen into the
    decision record together with its rules snapshot; later publishes never
    change this conclusion.  Returns ``(plan, decision, replayed)``.
    """

    _validate_window(planned_start, planned_end)

    if request_id:
        existing = session.scalar(
            sa.select(JobDecision).where(JobDecision.request_id == request_id)
        )
        if existing is not None:
            plan = session.get(JobPlan, existing.job_id) if existing.job_id else None
            return plan, existing, True

    decided_at = clock()
    version = get_effective_version(session, decided_at)
    active = _active_plans(session)
    candidate = engine_svc.JobFact(
        job_id="(candidate)",
        job_type=job_type,
        resources=frozenset(resources),
        planned_start=planned_start,
        planned_end=planned_end,
    )
    conflicts = engine_svc.evaluate(version.rules, candidate, active)

    plan: JobPlan | None = None
    try:
        if not conflicts:
            plan = JobPlan(
                id=new_id(),
                job_type=job_type,
                resources=list(resources),
                planned_start=planned_start,
                planned_end=planned_end,
                status="scheduled",
                request_id=request_id,
                created_at=decided_at,
            )
            session.add(plan)
            # Flush the parent row first: the decision row references it by FK
            # but no ORM relationship() drives insert ordering.
            session.flush()

        decision = _record_decision(
            session,
            decision_kind="schedule",
            decided_at=decided_at,
            version=version,
            job=plan,
            job_type=job_type,
            resources=resources,
            planned_start=planned_start,
            planned_end=planned_end,
            conflicts=conflicts,
            active=active,
            request_id=request_id,
        )
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        # A concurrent request with the same request_id won: converge on its
        # result instead of failing, so retries stay idempotent under races.
        if request_id:
            existing = session.scalar(
                sa.select(JobDecision).where(JobDecision.request_id == request_id)
            )
            if existing is not None:
                plan = session.get(JobPlan, existing.job_id) if existing.job_id else None
                return plan, existing, True
        raise ConflictError(
            "conflicting concurrent schedule request", detail={"cause": str(exc.orig)}
        ) from exc
    if plan is not None:
        session.refresh(plan)
    session.refresh(decision)
    return plan, decision, False


def start_job(session: Session, clock: Clock, *, job_id: str) -> tuple[JobPlan, JobDecision]:
    """Re-evaluate a scheduled job at start time and, if accepted, start it.

    A start decision is a fresh evaluation against the version effective
    *now* (which may differ from the schedule-time version); it is recorded
    once per job and never rewritten.
    """

    job = session.get(JobPlan, job_id)
    if job is None:
        raise NotFoundError(f"job {job_id} not found")
    prior = session.scalar(
        sa.select(JobDecision).where(
            JobDecision.job_id == job_id, JobDecision.decision_kind == "start"
        )
    )
    if prior is not None:
        raise ConflictError(
            f"job {job_id} already has a start decision ({prior.status}); "
            "decisions are immutable"
        )
    if job.status != "scheduled":
        raise ConflictError(f"job {job_id} is {job.status}, cannot be started")

    decided_at = clock()
    version = get_effective_version(session, decided_at)
    active = _active_plans(session, exclude_job_id=job.id)
    candidate = engine_svc.JobFact.from_row(job)
    conflicts = engine_svc.evaluate(version.rules, candidate, active)

    decision = _record_decision(
        session,
        decision_kind="start",
        decided_at=decided_at,
        version=version,
        job=job,
        job_type=job.job_type,
        resources=list(job.resources or []),
        planned_start=job.planned_start,
        planned_end=job.planned_end,
        conflicts=conflicts,
        active=active,
        request_id=None,
    )
    if not conflicts:
        job.status = "running"
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise ConflictError(
            "conflicting concurrent start decision", detail={"cause": str(exc.orig)}
        ) from exc
    session.refresh(job)
    session.refresh(decision)
    return job, decision


def evaluate_job(
    session: Session,
    clock: Clock,
    *,
    job_type: str,
    resources: list[str],
    planned_start: datetime,
    planned_end: datetime,
) -> dict[str, Any]:
    """Side-effect-free conflict check (dry run; nothing is persisted)."""

    _validate_window(planned_start, planned_end)
    decided_at = clock()
    version = get_effective_version(session, decided_at)
    active = _active_plans(session)
    candidate = engine_svc.JobFact(
        job_id="(candidate)",
        job_type=job_type,
        resources=frozenset(resources),
        planned_start=planned_start,
        planned_end=planned_end,
    )
    conflicts = engine_svc.evaluate(version.rules, candidate, active)
    return {
        "decision_kind": "evaluate",
        "decided_at": decided_at,
        "matrix_version_no": version.version_no,
        "matrix_rules_hash": version.rules_hash,
        "status": "rejected" if conflicts else "accepted",
        "conflicts": conflicts,
        "reason": (
            f"would be rejected by matrix v{version.version_no}: {len(conflicts)} conflict(s)"
            if conflicts
            else f"would be accepted under matrix v{version.version_no}: no conflicts"
        ),
    }


def get_decision(session: Session, decision_id: str) -> JobDecision:
    decision = session.get(JobDecision, decision_id)
    if decision is None:
        raise NotFoundError(f"decision {decision_id} not found")
    return decision


def list_decisions(
    session: Session, *, job_id: str | None = None, limit: int = 100
) -> list[JobDecision]:
    stmt = sa.select(JobDecision).order_by(JobDecision.decided_at, JobDecision.id).limit(limit)
    if job_id:
        stmt = stmt.where(JobDecision.job_id == job_id)
    return list(session.scalars(stmt).all())


def replay_decision(session: Session, decision_id: str) -> dict[str, Any]:
    """Re-run the conflict algorithm from the frozen snapshot only.

    The replay uses the rules snapshot and context frozen at decision time —
    never the current matrix — and verifies the snapshot's integrity hash, so
    historical conclusions remain reviewable after restarts and later
    publishes.
    """

    decision = get_decision(session, decision_id)
    snapshot = list(decision.matrix_rules_snapshot or [])
    actual_hash = engine_svc.rules_hash(snapshot)
    snapshot_intact = actual_hash == decision.matrix_rules_hash

    ctx = decision.frozen_context or {}
    active = [
        engine_svc.JobFact(
            job_id=j["job_id"],
            job_type=j["job_type"],
            resources=frozenset(j.get("resources") or []),
            planned_start=datetime.fromisoformat(j["planned_start"]),
            planned_end=datetime.fromisoformat(j["planned_end"]),
        )
        for j in ctx.get("active_jobs", [])
    ]
    candidate = engine_svc.JobFact(
        job_id=decision.job_id or "(candidate)",
        job_type=decision.job_type,
        resources=frozenset(decision.resources or []),
        planned_start=decision.planned_start,
        planned_end=decision.planned_end,
    )
    conflicts = engine_svc.evaluate(snapshot, candidate, active)
    status = "rejected" if conflicts else "accepted"
    return {
        "decision_id": decision.id,
        "decision_kind": decision.decision_kind,
        "matrix_version_no": decision.matrix_version_no,
        "matrix_rules_hash": decision.matrix_rules_hash,
        "snapshot_intact": snapshot_intact,
        "original_status": decision.status,
        "replayed_status": status,
        "replayed_conflicts": conflicts,
        "matches_original": status == decision.status and conflicts == decision.conflicts,
    }
