"""Pure conflict-evaluation logic for the mutex job matrix.

A rule declares that two job types are mutually exclusive.  If ``resources``
is empty, the rule applies to *any* overlapping jobs of the two types; if
``resources`` lists resource identifiers, the rule applies only when both
jobs touch at least one shared listed resource.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from app.errors import UnprocessableError


def normalize_rule(rule: dict[str, Any]) -> dict[str, Any]:
    """Validate one rule and return its canonical form.

    The unordered pair of job types is stored as ``(job_type_a, job_type_b)``
    sorted lexicographically, so the same pair expressed in either order is
    identical.
    """

    if not isinstance(rule, dict):
        raise UnprocessableError("rule must be an object")
    a = rule.get("job_type_a")
    b = rule.get("job_type_b")
    if not isinstance(a, str) or not a.strip():
        raise UnprocessableError("rule.job_type_a is required")
    if not isinstance(b, str) or not b.strip():
        raise UnprocessableError("rule.job_type_b is required")
    if a == b:
        raise UnprocessableError("a job type cannot be mutually exclusive with itself")
    resources = rule.get("resources", [])
    if resources is None:
        resources = []
    if not isinstance(resources, list) or not all(
        isinstance(r, str) and r.strip() for r in resources
    ):
        raise UnprocessableError("rule.resources must be a list of strings")
    description = rule.get("description", "")
    if description is None:
        description = ""
    if not isinstance(description, str):
        raise UnprocessableError("rule.description must be a string")
    lo, hi = sorted((a.strip(), b.strip()))
    return {
        "job_type_a": lo,
        "job_type_b": hi,
        "resources": sorted(set(resources)),
        "description": description,
    }


def normalize_rules(rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not isinstance(rules, list):
        raise UnprocessableError("rules must be a list")
    normalized = [normalize_rule(r) for r in rules]
    seen: set[tuple[str, str, tuple[str, ...]]] = set()
    for r in normalized:
        key = (r["job_type_a"], r["job_type_b"], tuple(r["resources"]))
        if key in seen:
            raise UnprocessableError(
                f"duplicate rule for {r['job_type_a']} / {r['job_type_b']} "
                f"resources={r['resources']}"
            )
        seen.add(key)
    return normalized


def rules_hash(rules: list[dict[str, Any]]) -> str:
    """Stable content hash of a rules list (used for integrity / audit)."""

    payload = json.dumps(rules, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class JobFact:
    job_id: str
    job_type: str
    resources: frozenset[str]
    planned_start: Any
    planned_end: Any

    @classmethod
    def from_row(cls, row) -> "JobFact":  # noqa: ANN001
        return cls(
            job_id=row.id,
            job_type=row.job_type,
            resources=frozenset(row.resources or []),
            planned_start=row.planned_start,
            planned_end=row.planned_end,
        )


def _time_overlaps(start_a, end_a, start_b, end_b) -> bool:  # noqa: ANN001
    # Half-open intervals: touching at an endpoint is not an overlap.
    return start_a < end_b and start_b < end_a


def _rule_matches(rule: dict[str, Any], candidate: JobFact, existing: JobFact) -> bool:
    pair = {candidate.job_type, existing.job_type}
    if pair != {rule["job_type_a"], rule["job_type_b"]}:
        return False
    rule_resources = set(rule.get("resources") or [])
    if rule_resources:
        if not (rule_resources & candidate.resources & existing.resources):
            return False
    return _time_overlaps(
        candidate.planned_start,
        candidate.planned_end,
        existing.planned_start,
        existing.planned_end,
    )


def evaluate(
    rules: list[dict[str, Any]],
    candidate: JobFact,
    existing: list[JobFact],
) -> list[dict[str, Any]]:
    """Return one conflict record per violated rule (deterministic order)."""

    conflicts: list[dict[str, Any]] = []
    # Rules are stored in canonical order; iterate in that order and, within a
    # rule, by existing job id, so conflict reasons are reproducible.
    for rule in rules:
        for other in sorted(existing, key=lambda j: j.job_id):
            if _rule_matches(rule, candidate, other):
                scope = (
                    f"on shared resources {sorted(set(rule.get('resources') or []) & candidate.resources & other.resources)}"
                    if rule.get("resources")
                    else "for the overlapping time window"
                )
                conflicts.append(
                    {
                        "rule": {
                            "job_type_a": rule["job_type_a"],
                            "job_type_b": rule["job_type_b"],
                            "resources": rule.get("resources") or [],
                            "description": rule.get("description", ""),
                        },
                        "conflicting_job_id": other.job_id,
                        "conflicting_job_type": other.job_type,
                        "basis": (
                            f"job types {rule['job_type_a']} and {rule['job_type_b']} are "
                            f"mutually exclusive {scope}"
                        ),
                    }
                )
    return conflicts
