from fastapi import APIRouter, Response, status
from pydantic import BaseModel

from app.core.db import check_database

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    status: str


@router.get("/healthz", operation_id="getHealth", summary="Liveness probe")
def healthz() -> HealthResponse:
    return HealthResponse(status="ok")


@router.get(
    "/readyz",
    operation_id="getReadiness",
    summary="Readiness probe (checks the database)",
    responses={503: {"model": HealthResponse}},
)
def readyz(response: Response) -> HealthResponse:
    if not check_database():
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return HealthResponse(status="database_unavailable")
    return HealthResponse(status="ok")
