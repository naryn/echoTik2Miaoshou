"""FastAPI 应用入口：中间件、异常处理、CORS、路由注册、健康检查。"""

import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api import (
    routes_admin,
    routes_auth,
    routes_batches,
    routes_clients,
    routes_images,
    routes_pricing,
    routes_rank,
    routes_tasks,
)
from app.api.deps import error_body, ok, set_request_id
from app.config import (
    CORS_ALLOW_ORIGINS,
    MIN_CLIENT_VERSION,
    PLUGIN_DOWNLOAD_URL,
    PLUGIN_VERSION,
)
from app.db import init_db
from app.services.errors import ApiError

# 客户端版本头：扩展每次请求都会带上自身版本号
CLIENT_VERSION_HEADER = "X-Client-Version"
# 浏览器网页（图片预览页等）使用的固定标识，不做版本校验
WEB_CLIENT_VERSION = "web"
# 无需版本校验的公开路径前缀（更新接口、下载、静态页、文档、网页专用 API）
VERSION_EXEMPT_PREFIXES = (
    "/healthz",
    "/favicon.ico",
    "/v1/plugin-update",
    "/plugin-download",
    "/pricing",
    "/pricing-assets",
    "/v1/pricing",
    "/collected-images",
    "/docs",
    "/redoc",
    "/openapi.json",
)


def is_client_version_ok(raw: str) -> bool:
    """判断客户端上报版本是否达到最低支持版本（缺失或非法版本一律视为过旧）。"""
    value = (raw or "").strip().lower()
    if value == WEB_CLIENT_VERSION:
        return True

    def parse(text: str) -> list[int]:
        """把 x.y.z 解析为数字列表，非数字段按 0 处理。"""
        return [int(item) if item.isdigit() else 0 for item in text.lstrip("v").split(".")]

    current = parse(value)
    minimum = parse(MIN_CLIENT_VERSION)
    for index in range(max(len(current), len(minimum))):
        mine = current[index] if index < len(current) else 0
        need = minimum[index] if index < len(minimum) else 0
        if mine != need:
            return mine > need
    return True


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """应用生命周期：启动时自动建表（幂等）。"""
    init_db()
    yield


def create_app() -> FastAPI:
    """创建并配置 FastAPI 应用实例。"""
    app = FastAPI(title="EchoTik Collector Server", version="1.0.0", lifespan=lifespan)
    static_dir = Path(__file__).parent / "static"
    app.mount("/pricing-assets", StaticFiles(directory=static_dir), name="pricing-assets")
    plugin_dir = static_dir / "plugins"
    app.mount("/plugin-download", StaticFiles(directory=plugin_dir), name="plugin-download")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[CORS_ALLOW_ORIGINS] if CORS_ALLOW_ORIGINS != "*" else ["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def normalize_leading_slashes(request: Request, call_next):
        """兼容客户端把以 / 结尾的服务地址与 API 路径直接拼接的情况。"""
        path = request.scope["path"]
        if path.startswith("//"):
            request.scope["path"] = "/" + path.lstrip("/")
        return await call_next(request)

    @app.middleware("http")
    async def enforce_client_version(request: Request, call_next):
        """强制更新：低于最低支持版本的插件请求直接返回 426，必须升级后才能继续使用。"""
        path = request.url.path
        if request.method == "OPTIONS" or path.startswith(VERSION_EXEMPT_PREFIXES):
            return await call_next(request)
        raw = request.headers.get(CLIENT_VERSION_HEADER, "")
        if is_client_version_ok(raw):
            return await call_next(request)
        return JSONResponse(
            status_code=426,
            content=error_body(
                "PLUGIN_UPDATE_REQUIRED",
                f"插件版本过低（当前 v{raw or '未知'}），请更新到 v{MIN_CLIENT_VERSION}：{PLUGIN_DOWNLOAD_URL}",
                False,
            ),
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

    @app.get("/pricing", include_in_schema=False)
    def pricing_page():
        """由 FastAPI 托管的 MX POP 定价网页；计算结果来自后端 API。"""
        return FileResponse(static_dir / "pricing.html")

    @app.get("/collected-images", include_in_schema=False)
    def collected_images_page():
        """图片收集预览页：输入 auth token 后查看已上传到服务端的图片。"""
        return FileResponse(static_dir / "collected-images.html")

    @app.get("/v1/plugin-update")
    def plugin_update():
        """返回当前可手动安装的插件版本与下载地址。"""
        return ok(
            {
                "version": PLUGIN_VERSION,
                "download_url": PLUGIN_DOWNLOAD_URL,
                "notes": "",
            }
        )

    app.include_router(routes_clients.router)
    app.include_router(routes_auth.router)
    app.include_router(routes_rank.router)
    app.include_router(routes_batches.router)
    app.include_router(routes_tasks.router)
    app.include_router(routes_admin.router)
    app.include_router(routes_images.router)
    app.include_router(routes_pricing.router)
    return app


app = create_app()
