from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.core.config import get_settings
from app.core.logging import configure_logging
from app.modules.collections.router import router as collections_router
from app.modules.company.router import router as company_router
from app.modules.dashboard.router import router as dashboard_router
from app.modules.health.router import router as health_router
from app.modules.imports.router import router as imports_router
from app.modules.me.router import router as me_router
from app.modules.petty_cash.router import router as petty_cash_router
from app.modules.public_pay.router import router as public_router
from app.modules.settings.router import router as settings_router
from app.storage.base import StorageError


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging()

    app = FastAPI(
        title="Collections API",
        version="0.1.0",
        docs_url=None if settings.is_production else "/docs",
        redoc_url=None,
        openapi_url=None if settings.is_production else "/openapi.json",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
        allow_credentials=False,  # bearer tokens only; no cookies
        max_age=600,
    )

    @app.exception_handler(StorageError)
    async def storage_error(_request: Request, exc: StorageError) -> JSONResponse:
        logging.getLogger(__name__).warning("file storage failed: %s", exc)  # status only
        return JSONResponse(status_code=502, content={"detail": "File storage is unavailable"})

    @app.middleware("http")
    async def security_headers(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Cache-Control", "no-store")
        return response

    app.include_router(health_router)
    app.include_router(me_router)
    app.include_router(settings_router)
    app.include_router(company_router)
    app.include_router(imports_router)
    app.include_router(collections_router)
    app.include_router(petty_cash_router)
    app.include_router(dashboard_router)
    app.include_router(public_router)
    return app


app = create_app()
