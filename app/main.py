"""Application factory."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.api import router
from app.clock import Clock
from app.db import DEFAULT_DATABASE_URL, create_app_engine, make_session_factory
from app.errors import DomainError
from app.models import Base
from app.schemas import HealthOut
from app.services.matrix import seed_baseline_if_empty

OPENAPI_TAGS = [
    {"name": "matrix", "description": "Mutex matrix drafts, versions and publishing"},
    {"name": "decisions", "description": "Scheduling/starting decisions with frozen snapshots"},
]


def create_app(database_url: str = DEFAULT_DATABASE_URL, *, clock: Clock | None = None) -> FastAPI:
    app = FastAPI(
        title="Mutex Job Matrix Service",
        version="2.0.0",
        description=(
            "Mutually-exclusive job matrix with draft / publish / effective-window "
            "versioning. Scheduling and starting decisions freeze the applicable "
            "matrix version and its conflict-judgment basis; later publishes only "
            "affect new decisions and never rewrite historical plans, receipts or "
            "audit records."
        ),
        openapi_tags=OPENAPI_TAGS,
    )

    engine = create_app_engine(database_url)
    Base.metadata.create_all(engine)
    app.state.engine = engine
    app.state.session_factory = make_session_factory(engine)
    app.state.clock = clock or Clock()

    # Safe migration: fold pre-versioning matrix data into immutable v1.
    with app.state.session_factory() as session:
        seed_baseline_if_empty(session, app.state.clock)

    @app.exception_handler(DomainError)
    async def domain_error_handler(_request: Request, exc: DomainError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.code, "message": exc.message, "detail": exc.detail}},
        )

    @app.get("/health", response_model=HealthOut, tags=["meta"])
    def health() -> HealthOut:
        return HealthOut()

    app.include_router(router)
    return app


app = create_app()
