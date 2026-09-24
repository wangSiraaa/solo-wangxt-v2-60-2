"""Request/response schemas for the HTTP API."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


def _require_aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("datetime must include a timezone (ISO-8601, e.g. 2026-09-24T12:00:00Z)")
    return value


class RuleIn(BaseModel):
    job_type_a: str = Field(min_length=1)
    job_type_b: str = Field(min_length=1)
    resources: list[str] = Field(default_factory=list)
    description: str = ""


class DraftIn(BaseModel):
    rules: list[RuleIn]


class DraftOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    rules: list[dict[str, Any]]
    updated_at: datetime
    updated_by: str


class PublishIn(BaseModel):
    effective_from: datetime
    request_id: str | None = Field(default=None, max_length=128)

    _aware = field_validator("effective_from")(_require_aware)


class VersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    version_no: int
    rules: list[dict[str, Any]]
    rules_hash: str
    effective_from: datetime
    effective_to: datetime | None
    published_at: datetime
    published_by: str
    source: str
    request_id: str | None


class ScheduleIn(BaseModel):
    job_type: str = Field(min_length=1)
    resources: list[str] = Field(default_factory=list)
    planned_start: datetime
    planned_end: datetime
    request_id: str | None = Field(default=None, max_length=128)

    _aware_start = field_validator("planned_start")(_require_aware)
    _aware_end = field_validator("planned_end")(_require_aware)


class EvaluateIn(BaseModel):
    job_type: str = Field(min_length=1)
    resources: list[str] = Field(default_factory=list)
    planned_start: datetime
    planned_end: datetime

    _aware_start = field_validator("planned_start")(_require_aware)
    _aware_end = field_validator("planned_end")(_require_aware)


class JobOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    job_type: str
    resources: list[str]
    planned_start: datetime
    planned_end: datetime
    status: str
    request_id: str | None
    created_at: datetime


class DecisionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    decision_kind: str
    decided_at: datetime
    matrix_version_id: str
    matrix_version_no: int
    matrix_rules_hash: str
    matrix_rules_snapshot: list[dict[str, Any]]
    job_id: str | None
    job_type: str
    resources: list[str]
    planned_start: datetime
    planned_end: datetime
    status: str
    conflicts: list[dict[str, Any]]
    reason: str
    frozen_context: dict[str, Any]
    request_id: str | None


class ScheduleResultOut(BaseModel):
    job: JobOut | None
    decision: DecisionOut
    replayed: bool


class StartResultOut(BaseModel):
    job: JobOut
    decision: DecisionOut


class EvaluateOut(BaseModel):
    decision_kind: str
    decided_at: datetime
    matrix_version_no: int
    matrix_rules_hash: str
    status: str
    conflicts: list[dict[str, Any]]
    reason: str


class ReplayOut(BaseModel):
    decision_id: str
    decision_kind: str
    matrix_version_no: int
    matrix_rules_hash: str
    snapshot_intact: bool
    original_status: str
    replayed_status: str
    replayed_conflicts: list[dict[str, Any]]
    matches_original: bool


class ErrorOut(BaseModel):
    error: dict[str, Any]


class HealthOut(BaseModel):
    status: Literal["ok"] = "ok"
