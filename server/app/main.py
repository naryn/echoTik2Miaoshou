"""FastAPI 应用入口：中间件、异常处理、CORS、路由注册、健康检查。"""

import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import routes_batches, routes_clients, routes_rank, routes_tasks
from app.api.deps import error_body, ok, set_request_id
from app.config import CORS_ALLOW_ORIGINS
from app.db import init_db
from app.services.errors import ApiError


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """应用生命周期：启动时自动建表（幂等）。"""
    init_db()
    yield


def create_app() -> FastAPI:
    """创建并配置 FastAPI 应用实例。"""
    app = FastAPI(title="EchoTik Collector Server", version="1.0.0", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[CORS_ALLOW_ORIGINS] if CORS_ALLOW_ORIGINS != "*" else ["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):
        """为每个请求生成 request_id 并写入响应包装。"""
        set_request_id(f"req_{uuid.uuid4().hex}")
        return await call_next(request)

    @app.exception_handler(ApiError)
    async def api_error_handler(_request: Request, exc: ApiError):
        """业务错误统一转换为 { data, error, request_id } 包装。"""
        return JSONResponse(
            status_code=exc.http_status,
            content=error_body(exc.code, exc.message, exc.retryable),
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(_request: Request, exc: RequestValidationError):
        """参数校验错误统一包装为 VALIDATION_ERROR。"""
        return JSONResponse(
            status_code=422,
            content=error_body("VALIDATION_ERROR", str(exc.errors()[:3]), False),
        )

    @app.exception_handler(Exception)
    async def unhandled_error_handler(_request: Request, exc: Exception):
        """兜底错误处理，避免泄露内部细节。"""
        return JSONResponse(
            status_code=500,
            content=error_body("INTERNAL_ERROR", "服务端内部错误", True),
        )

    @app.get("/healthz")
    def healthz():
        """健康检查。"""
        return ok({"status": "ok"})

    app.include_router(routes_clients.router)
    app.include_router(routes_rank.router)
    app.include_router(routes_batches.router)
    app.include_router(routes_tasks.router)
    return app


app = create_app()
