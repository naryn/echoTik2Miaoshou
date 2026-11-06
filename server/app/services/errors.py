"""统一业务错误：稳定 code / message / retryable，API 层转换为统一响应包装。"""


class ApiError(Exception):
    """业务错误基类，携带稳定错误码与是否可重试标记。"""

    def __init__(self, code: str, message: str, http_status: int = 400, retryable: bool = False):
        """初始化业务错误。

        :param code: 稳定机器可读错误码
        :param message: 面向用户/调用方的描述
        :param http_status: HTTP 状态码
        :param retryable: 客户端是否可安全重试
        """
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status
        self.retryable = retryable


def unauthorized(message: str = "客户端凭证缺失或无效") -> ApiError:
    """构造 401 未认证错误。"""
    return ApiError("UNAUTHORIZED", message, http_status=401, retryable=False)


def forbidden(message: str = "资源不属于当前客户端") -> ApiError:
    """构造 403 越权访问错误。"""
    return ApiError("FORBIDDEN_OWNERSHIP", message, http_status=403, retryable=False)


def not_found(resource: str = "资源") -> ApiError:
    """构造 404 资源不存在错误。"""
    return ApiError("NOT_FOUND", f"{resource}不存在", http_status=404, retryable=False)


def admin_forbidden(message: str = "当前认证 Token 不具备管理员权限") -> ApiError:
    """构造管理端 403 错误（Token 缺失/无效/角色不是 ADMIN）。"""
    return ApiError("ADMIN_FORBIDDEN", message, http_status=403, retryable=False)


def conflict(code: str, message: str, retryable: bool = False) -> ApiError:
    """构造 409 状态冲突错误。"""
    return ApiError(code, message, http_status=409, retryable=retryable)
