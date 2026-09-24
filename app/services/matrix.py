"""Matrix versioning service: migration, drafts, publishing, selection."""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone
from typing import Any

import sqlalchemy as sa
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.clock import Clock, EPOCH_START
from app.errors import (
    ConflictError,
    IdempotencyMismatchError,
    NotFoundError,
    OverlapError,
    UnprocessableError,
)
from app.models import LegacyMatrixRule, MatrixDraft, MatrixVersion, new_id
from app.services.engine import normalize_rules, rules_hash

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Drafts
# ---------------------------------------------------------------------------

def get_draft(session: Session) -> MatrixDraft | None:
    return session.execute(sa.select(MatrixDraft).limit(1)).scalar_one_or_none()


def save_draft(session: Session, clock: Clock, rules: list[dict[str, Any]], actor: str) -> MatrixDraft:
    normalized = normalize_rules(rules)
    draft = get_draft(session)
    if draft is None:
        draft = MatrixDraft(rules=normalized, updated_at=clock(), updated_by=actor)
        session.add(draft)
    else:
        draft.rules = normalized
        draft.updated_at = clock()
        draft.updated_by = actor
    session.commit()
    session.refresh(draft)
    return draft


# ---------------------------------------------------------------------------
# Version queries / cross-effective-boundary selection
# ---------------------------------------------------------------------------

def list_versions(session: Session) -> list[MatrixVersion]:
    return list(
        session.scalars(sa.select(MatrixVersion).order_by(MatrixVersion.version_no)).all()
    )


def get_version(session: Session, version_no: int) -> MatrixVersion:
    version = session.scalar(sa.select(MatrixVersion).where(MatrixVersion.version_no == version_no))
    if version is None:
        raise NotFoundError(f"matrix version {version_no} not found")
    return version


def get_effective_version(session: Session, at: datetime) -> MatrixVersion:
    """Select the version whose half-open effective window contains ``at``.

    Windows never overlap, so the rule is simply: highest ``effective_from``
    not later than ``at``.  A missing result can only happen before migration
    (impossible once startup seeding has run).
    """

    if at.tzinfo is None:
        raise UnprocessableError("effective-time lookup requires an aware UTC datetime")
    stmt = (
        sa.select(MatrixVersion)
        .where(MatrixVersion.effective_from <= at)
        .order_by(MatrixVersion.effective_from.desc())
        .limit(1)
    )
    version = session.scalar(stmt)
    if version is None:
        raise NotFoundError("no matrix version is effective at the requested time")
    return version


# ---------------------------------------------------------------------------
# Safe migration of pre-versioning data into immutable baseline v1
# ---------------------------------------------------------------------------

def seed_baseline_if_empty(session: Session, clock: Clock) -> MatrixVersion | None:
    """Migrate legacy rows into baseline version v1 on first startup.

    Idempotent and concurrency-safe: if a v1 already exists (another process
    or an earlier startup did the migration) this is a no-op, and the legacy
    table is left untouched for audit.
    """

    existing = session.scalar(sa.select(MatrixVersion).where(MatrixVersion.version_no == 1))
    if existing is not None:
        return None

    legacy_rows = list(
        session.scalars(
            sa.select(LegacyMatrixRule).order_by(
                LegacyMatrixRule.job_type_a, LegacyMatrixRule.job_type_b
            )
        ).all()
    )
    rules = normalize_rules(
        [
            {
                "job_type_a": r.job_type_a,
                "job_type_b": r.job_type_b,
                "resources": list(r.resources or []),
                "description": r.description or "",
            }
            for r in legacy_rows
        ]
    )
    now = clock()
    baseline = MatrixVersion(
        version_no=1,
        rules=rules,
        rules_hash=rules_hash(rules),
        effective_from=EPOCH_START,
        effective_to=None,
        published_at=now,
        published_by="migration",
        source="migration",
    )
    draft = MatrixDraft(rules=rules, updated_at=now, updated_by="migration")
    session.add_all([baseline, draft])
    try:
        session.commit()
    except IntegrityError:
        # Another worker created v1 concurrently.
        session.rollback()
        log.info("baseline v1 already created by another process; migration skipped")
        return None
    log.info("migrated %d legacy rules into immutable baseline v1", len(rules))
    return baseline


# ---------------------------------------------------------------------------
# Publishing (locked against concurrency, overlap-rejecting, idempotent)
# ---------------------------------------------------------------------------

def _publish_request_hash(effective_from: datetime) -> str:
    """Fingerprint of the publish *request* (its only payload: effective_from).

    The idempotency key binds to the request, not to the draft content, so a
    retry of the same request always replays the original result.
    """

    instant = effective_from.astimezone(timezone.utc).isoformat(timespec="microseconds")
    return hashlib.sha256(instant.encode("utf-8")).hexdigest()


def publish_draft(
    session: Session,
    clock: Clock,
    *,
    effective_from: datetime,
    actor: str,
    request_id: str | None,
) -> tuple[MatrixVersion, bool]:
    """Publish the current draft as a new version.

    Returns ``(version, already_existed)``.  ``already_existed=True`` when the
    request was served from the idempotency record (a retried publish).

    Guarantees:
      * ``effective_from`` must not be in the past;
      * effective windows never overlap: the new ``effective_from`` must be
        strictly later than the latest published one, else ``OverlapError``;
      * identical ``request_id`` retries return the original result; the same
        key with a different payload is rejected;
      * the publish path takes a write lock so concurrent publishes serialize
        and only one wins per effective time.
    """

    if effective_from.tzinfo is None:
        raise UnprocessableError("effective_from must be an ISO-8601 datetime with timezone")
    now = clock()
    if effective_from < now:
        raise UnprocessableError(
            "effective_from must be the current time or in the future; "
            "publishing a retroactive version would rewrite history"
        )

    engine = session.get_bind()
    new_pk = new_id()
    info: dict[str, str] = {}

    if engine.dialect.name == "sqlite":
        # AUTOCOMMIT isolation level leaves transaction control to us so we
        # can acquire the writer lock up front with BEGIN IMMEDIATE.
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            dbapi = conn.connection.dbapi_connection
            dbapi.execute("BEGIN IMMEDIATE")
            try:
                _publish_locked(conn, new_pk, clock, effective_from, actor, request_id, info)
                dbapi.commit()
            except Exception:
                dbapi.rollback()
                raise
    else:  # pragma: no cover - exercised only on non-SQLite databases
        with engine.connect() as conn:
            with conn.begin():
                _publish_locked(conn, new_pk, clock, effective_from, actor, request_id, info, lock=True)

    # Drop any stale read snapshot the API session may hold before looking up
    # the just-committed row.
    session.rollback()
    version = session.get(MatrixVersion, info.get("returned_id", new_pk))
    assert version is not None
    return version, bool(info.get("already_existed"))


def _publish_locked(
    conn,  # noqa: ANN001 - SQLAlchemy Connection
    new_pk: str,
    clock: Clock,
    effective_from: datetime,
    actor: str,
    request_id: str | None,
    info: dict[str, str],
    *,
    lock: bool = False,
) -> None:
    versions = MatrixVersion.__table__
    drafts = MatrixDraft.__table__

    # 1) Idempotency check *inside* the critical section so two concurrent
    #    retries resolve to the same published row.
    if request_id:
        stmt = sa.select(versions).where(versions.c.request_id == request_id)
        existing = conn.execute(stmt).mappings().first()
        if existing is not None:
            if existing["request_hash"] != _publish_request_hash(effective_from):
                raise IdempotencyMismatchError(
                    f"request_id {request_id!r} was already used with a different payload"
                )
            info["returned_id"] = existing["id"]
            info["already_existed"] = "1"
            return

    # 2) Lock/read the latest published version (all writers serialize here).
    stmt = sa.select(versions).order_by(versions.c.version_no.desc()).limit(1)
    if lock:
        stmt = stmt.with_for_update()
    latest = conn.execute(stmt).mappings().first()
    if latest is None:
        raise ConflictError("baseline v1 is missing; run migration before publishing")

    # 3) Overlap rejection: equal effective_from (duplicate publish) or an
    #    earlier/equal boundary both collapse to an overlapping window.
    if effective_from <= latest["effective_from"]:
        raise OverlapError(
            "effective window overlaps an existing published version",
            detail={
                "requested_effective_from": effective_from.isoformat(),
                "latest_version_no": latest["version_no"],
                "latest_effective_from": latest["effective_from"].isoformat()
                if isinstance(latest["effective_from"], datetime)
                else latest["effective_from"],
            },
        )

    # 4) Freeze the draft content exactly as it is at publish time.
    draft_row = conn.execute(sa.select(drafts).limit(1)).mappings().first()
    if draft_row is None:
        raise NotFoundError("no draft matrix exists to publish")
    rules = normalize_rules(list(draft_row["rules"] or []))
    content_hash = rules_hash(rules)
    req_hash = _publish_request_hash(effective_from)

    # 5) Close the previously open window and insert the new version.
    conn.execute(
        versions.update()
        .where(versions.c.id == latest["id"])
        .values(effective_to=effective_from)
    )
    conn.execute(
        versions.insert().values(
            id=new_pk,
            version_no=int(latest["version_no"]) + 1,
            rules=rules,
            rules_hash=content_hash,
            effective_from=effective_from,
            effective_to=None,
            published_at=clock(),
            published_by=actor,
            source="api",
            request_id=request_id,
            request_hash=req_hash,
        )
    )
    info["returned_id"] = new_pk
