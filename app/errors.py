"""Domain errors mapped to HTTP responses by the API layer."""

from __future__ import annotations


class DomainError(Exception):
    """Base class for expected business-rule failures."""

    status_code = 400
    code = "domain_error"

    def __init__(self, message: str, *, detail: dict | None = None):
        super().__init__(message)
        self.message = message
        self.detail = detail or {}


class NotFoundError(DomainError):
    status_code = 404
    code = "not_found"


class ConflictError(DomainError):
    """A uniqueness / state conflict (duplicate publish, duplicate decision, ...)."""

    status_code = 409
    code = "conflict"


class OverlapError(ConflictError):
    """The requested effective window overlaps an already published version."""

    code = "effective_window_overlap"


class IdempotencyMismatchError(ConflictError):
    """An idempotency key was reused with a different request payload."""

    code = "idempotency_mismatch"


class UnprocessableError(DomainError):
    """The request is well-formed but violates a domain invariant."""

    status_code = 422
    code = "unprocessable"
