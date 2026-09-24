"""ORM models.

Timestamps are stored as ISO-8601 UTC text (``DateTimeText``) so that SQLite
comparisons are exact, timezone-aware and lexicographically ordered.  On
other databases the same columns map to native ``TIMESTAMP WITH TIME ZONE``.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

import sqlalchemy as sa
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def new_id() -> str:
    return uuid.uuid4().hex


class DateTimeText(sa.types.TypeDecorator):
    """Aware-UTC datetime stored as ISO-8601 text on SQLite."""

    impl = sa.String(32)
    cache_ok = True

    def load_dialect_impl(self, dialect):  # noqa: ANN001, ANN201
        if dialect.name == "sqlite":
            return dialect.type_descriptor(sa.String(32))
        return dialect.type_descriptor(sa.DateTime(timezone=True))

    def process_bind_param(self, value: datetime | None, dialect):  # noqa: ANN001, ANN201
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("naive datetime is not allowed; use aware UTC")
        value = value.astimezone(timezone.utc)
        if dialect.name == "sqlite":
            return value.isoformat(timespec="microseconds")
        return value

    def process_result_value(self, value, dialect):  # noqa: ANN001, ANN201
        if value is None:
            return None
        if isinstance(value, datetime):
            result = value
        else:
            result = datetime.fromisoformat(str(value))
        if result.tzinfo is None:
            result = result.replace(tzinfo=timezone.utc)
        return result.astimezone(timezone.utc)


class Base(DeclarativeBase):
    pass


class MatrixVersion(Base):
    """An immutable published snapshot of the mutex matrix.

    ``effective_from`` is inclusive, ``effective_to`` exclusive; the latest
    published version has ``effective_to IS NULL`` (open window).  Windows of
    distinct versions never overlap (enforced by the publish path plus the
    unique index on ``effective_from``).
    """

    __tablename__ = "matrix_versions"
    __table_args__ = (
        sa.UniqueConstraint("effective_from", name="uq_matrix_versions_effective_from"),
        sa.UniqueConstraint("request_id", name="uq_matrix_versions_request_id"),
    )

    id: Mapped[str] = mapped_column(sa.String(32), primary_key=True, default=new_id)
    version_no: Mapped[int] = mapped_column(sa.Integer, unique=True, nullable=False)
    rules: Mapped[list[dict[str, Any]]] = mapped_column(sa.JSON, nullable=False)
    rules_hash: Mapped[str] = mapped_column(sa.String(64), nullable=False)
    effective_from: Mapped[datetime] = mapped_column(DateTimeText, nullable=False)
    effective_to: Mapped[datetime | None] = mapped_column(DateTimeText, nullable=True)
    published_at: Mapped[datetime] = mapped_column(DateTimeText, nullable=False)
    published_by: Mapped[str] = mapped_column(sa.String(128), nullable=False)
    source: Mapped[str] = mapped_column(sa.String(32), nullable=False, default="api")
    request_id: Mapped[str | None] = mapped_column(sa.String(128), nullable=True)
    request_hash: Mapped[str | None] = mapped_column(sa.String(64), nullable=True)


class MatrixDraft(Base):
    """The single editable working copy of the matrix."""

    __tablename__ = "matrix_drafts"

    id: Mapped[str] = mapped_column(sa.String(32), primary_key=True, default=new_id)
    rules: Mapped[list[dict[str, Any]]] = mapped_column(sa.JSON, nullable=False, default=list)
    updated_at: Mapped[datetime] = mapped_column(DateTimeText, nullable=False)
    updated_by: Mapped[str] = mapped_column(sa.String(128), nullable=False)


class JobPlan(Base):
    """A job that was accepted by a scheduling decision."""

    __tablename__ = "job_plans"
    __table_args__ = (
        sa.UniqueConstraint("request_id", name="uq_job_plans_request_id"),
    )

    id: Mapped[str] = mapped_column(sa.String(32), primary_key=True, default=new_id)
    job_type: Mapped[str] = mapped_column(sa.String(128), nullable=False)
    resources: Mapped[list[str]] = mapped_column(sa.JSON, nullable=False, default=list)
    planned_start: Mapped[datetime] = mapped_column(DateTimeText, nullable=False)
    planned_end: Mapped[datetime] = mapped_column(DateTimeText, nullable=False)
    status: Mapped[str] = mapped_column(sa.String(16), nullable=False, default="scheduled")
    request_id: Mapped[str | None] = mapped_column(sa.String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTimeText, nullable=False)


class JobDecision(Base):
    """An immutable audit record of a conflict evaluation.

    Every decision freezes the matrix version it used (``matrix_version_id`` /
    ``matrix_version_no``), the exact rules snapshot and the evaluation
    context, so historical conclusions can be replayed and reviewed after
    restarts and after later matrix publishes.
    """

    __tablename__ = "job_decisions"
    __table_args__ = (
        sa.UniqueConstraint("request_id", name="uq_job_decisions_request_id"),
        sa.Index(
            "uq_job_decisions_job_kind",
            "job_id",
            "decision_kind",
            unique=True,
            sqlite_where=sa.text("job_id IS NOT NULL"),
            postgresql_where=sa.text("job_id IS NOT NULL"),
        ),
    )

    id: Mapped[str] = mapped_column(sa.String(32), primary_key=True, default=new_id)
    decision_kind: Mapped[str] = mapped_column(sa.String(16), nullable=False)
    decided_at: Mapped[datetime] = mapped_column(DateTimeText, nullable=False)
    matrix_version_id: Mapped[str] = mapped_column(
        sa.ForeignKey("matrix_versions.id"), nullable=False
    )
    matrix_version_no: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    matrix_rules_hash: Mapped[str] = mapped_column(sa.String(64), nullable=False)
    matrix_rules_snapshot: Mapped[list[dict[str, Any]]] = mapped_column(sa.JSON, nullable=False)
    job_id: Mapped[str | None] = mapped_column(
        sa.ForeignKey("job_plans.id"), nullable=True
    )
    job_type: Mapped[str] = mapped_column(sa.String(128), nullable=False)
    resources: Mapped[list[str]] = mapped_column(sa.JSON, nullable=False, default=list)
    planned_start: Mapped[datetime] = mapped_column(DateTimeText, nullable=False)
    planned_end: Mapped[datetime] = mapped_column(DateTimeText, nullable=False)
    status: Mapped[str] = mapped_column(sa.String(16), nullable=False)
    conflicts: Mapped[list[dict[str, Any]]] = mapped_column(sa.JSON, nullable=False, default=list)
    reason: Mapped[str] = mapped_column(sa.Text, nullable=False, default="")
    frozen_context: Mapped[dict[str, Any]] = mapped_column(sa.JSON, nullable=False, default=dict)
    request_id: Mapped[str | None] = mapped_column(sa.String(128), nullable=True)


class LegacyMatrixRule(Base):
    """Pre-versioning storage of the matrix (the "current matrix data").

    Rows here are migrated into the immutable baseline version v1 on first
    startup; the table itself is never read afterwards.
    """

    __tablename__ = "legacy_matrix_rules"

    id: Mapped[str] = mapped_column(sa.String(32), primary_key=True, default=new_id)
    job_type_a: Mapped[str] = mapped_column(sa.String(128), nullable=False)
    job_type_b: Mapped[str] = mapped_column(sa.String(128), nullable=False)
    resources: Mapped[list[str]] = mapped_column(sa.JSON, nullable=False, default=list)
    description: Mapped[str] = mapped_column(sa.Text, nullable=False, default="")
