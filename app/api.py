"""HTTP API: drafts, versions, publish, decisions, replay."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from sqlalchemy.orm import Session

from app import schemas
from app.clock import Clock
from app.services import jobs as jobs_svc
from app.services import matrix as matrix_svc

router = APIRouter()


def get_session(request: Request):  # noqa: ANN201
    factory = request.app.state.session_factory
    with factory() as session:
        yield session


def get_clock(request: Request) -> Clock:
    return request.app.state.clock


Actor = Annotated[str | None, Header(alias="X-Actor", max_length=128)]


def _actor(x_actor: str | None) -> str:
    return x_actor or "system"


# ---------------------------------------------------------------------------
# Draft
# ---------------------------------------------------------------------------

@router.get("/matrix/draft", response_model=schemas.DraftOut, tags=["matrix"])
def read_draft(session: Session = Depends(get_session)):
    draft = matrix_svc.get_draft(session)
    if draft is None:
        return schemas.DraftOut(
            rules=[], updated_at=datetime(1, 1, 1, tzinfo=timezone.utc), updated_by=""
        )
    return draft


@router.put("/matrix/draft", response_model=schemas.DraftOut, tags=["matrix"])
def write_draft(
    body: schemas.DraftIn,
    session: Session = Depends(get_session),
    clock: Clock = Depends(get_clock),
    x_actor: Actor = None,
):
    return matrix_svc.save_draft(
        session, clock, [r.model_dump() for r in body.rules], _actor(x_actor)
    )


# ---------------------------------------------------------------------------
# Versions / publish
# ---------------------------------------------------------------------------

@router.get("/matrix/versions", response_model=list[schemas.VersionOut], tags=["matrix"])
def list_versions(session: Session = Depends(get_session)):
    return matrix_svc.list_versions(session)


@router.get("/matrix/versions/effective", response_model=schemas.VersionOut, tags=["matrix"])
def effective_version(at: datetime = Query(...), session: Session = Depends(get_session)):
    """Resolve which version governs a given instant (boundary selection)."""
    return matrix_svc.get_effective_version(session, at)


@router.get("/matrix/versions/{version_no}", response_model=schemas.VersionOut, tags=["matrix"])
def get_version(version_no: int, session: Session = Depends(get_session)):
    return matrix_svc.get_version(session, version_no)


@router.post(
    "/matrix/versions",
    response_model=schemas.VersionOut,
    status_code=201,
    tags=["matrix"],
    responses={
        200: {
            "model": schemas.VersionOut,
            "description": "Idempotent replay of an earlier publish with the same request_id",
        }
    },
)
def publish(
    body: schemas.PublishIn,
    response: Response,
    session: Session = Depends(get_session),
    clock: Clock = Depends(get_clock),
    x_actor: Actor = None,
):
    version, already_existed = matrix_svc.publish_draft(
        session,
        clock,
        effective_from=body.effective_from,
        actor=_actor(x_actor),
        request_id=body.request_id,
    )
    if already_existed:
        response.status_code = 200
    return version


# ---------------------------------------------------------------------------
# Job decisions
# ---------------------------------------------------------------------------

@router.post(
    "/jobs/schedule",
    response_model=schemas.ScheduleResultOut,
    status_code=201,
    tags=["decisions"],
    responses={200: {"description": "Idempotent replay of an earlier schedule request"}},
)
def schedule(
    body: schemas.ScheduleIn,
    response: Response,
    session: Session = Depends(get_session),
    clock: Clock = Depends(get_clock),
):
    plan, decision, replayed = jobs_svc.schedule_job(
        session,
        clock,
        job_type=body.job_type,
        resources=body.resources,
        planned_start=body.planned_start,
        planned_end=body.planned_end,
        request_id=body.request_id,
    )
    if replayed:
        response.status_code = 200
    return schemas.ScheduleResultOut(
        job=schemas.JobOut.model_validate(plan) if plan else None,
        decision=schemas.DecisionOut.model_validate(decision),
        replayed=replayed,
    )


@router.post(
    "/jobs/{job_id}/start",
    response_model=schemas.StartResultOut,
    tags=["decisions"],
)
def start(
    job_id: str,
    session: Session = Depends(get_session),
    clock: Clock = Depends(get_clock),
):
    job, decision = jobs_svc.start_job(session, clock, job_id=job_id)
    return schemas.StartResultOut(job=job, decision=decision)


@router.post(
    "/decisions/evaluate",
    response_model=schemas.EvaluateOut,
    tags=["decisions"],
)
def evaluate(
    body: schemas.EvaluateIn,
    session: Session = Depends(get_session),
    clock: Clock = Depends(get_clock),
):
    """Dry-run conflict check against the currently effective version.

    Purely read-only: no plan is created and no decision is recorded.
    """
    return jobs_svc.evaluate_job(
        session,
        clock,
        job_type=body.job_type,
        resources=body.resources,
        planned_start=body.planned_start,
        planned_end=body.planned_end,
    )


@router.get("/decisions", response_model=list[schemas.DecisionOut], tags=["decisions"])
def list_decisions(
    job_id: str | None = None,
    limit: int = Query(default=100, le=1000),
    session: Session = Depends(get_session),
):
    return jobs_svc.list_decisions(session, job_id=job_id, limit=limit)


@router.get("/decisions/{decision_id}", response_model=schemas.DecisionOut, tags=["decisions"])
def get_decision(decision_id: str, session: Session = Depends(get_session)):
    return jobs_svc.get_decision(session, decision_id)


@router.post(
    "/decisions/{decision_id}/replay",
    response_model=schemas.ReplayOut,
    tags=["decisions"],
)
def replay(decision_id: str, session: Session = Depends(get_session)):
    """Replay a historical decision from its frozen snapshot (audit)."""
    return jobs_svc.replay_decision(session, decision_id)
