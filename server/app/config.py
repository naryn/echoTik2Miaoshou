"""服务端全局配置：数据库地址、租约时长、批量上传上限等。"""

import os

# SQLite 数据库文件位置，可用环境变量覆盖（默认 server/data/echotik.db）
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DB_PATH = os.path.join(BASE_DIR, "data", "echotik.db")

DATABASE_URL = os.environ.get("DATABASE_URL", f"sqlite:///{DEFAULT_DB_PATH}")

# 榜单数据来源平台白名单与默认值（扩展可上报多个榜单源，区别于 Product.platform）
ALLOWED_SOURCE_PLATFORMS = {"ECHOTIK", "FASTMOSS"}
DEFAULT_SOURCE_PLATFORM = "ECHOTIK"

# 任务租约默认时长（秒），规范默认 10 分钟
LEASE_TTL_SECONDS = int(os.environ.get("LEASE_TTL_SECONDS", "600"))

# entries:upsert 单批最大条数
MAX_ENTRIES_BATCH = 200

# 客户端凭证长度（token_urlsafe 字节数）
CLIENT_TOKEN_BYTES = 32

# CORS 允许的扩展来源（Chrome 扩展 origin 为 chrome-extension://<id>，MVP 全放开）
CORS_ALLOW_ORIGINS = os.environ.get("CORS_ALLOW_ORIGINS", "*")
