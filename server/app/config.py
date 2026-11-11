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

# 插件图片收集：单张上限与落盘目录（数据库只存相对路径）
MAX_IMAGE_BYTES = int(os.environ.get("MAX_IMAGE_BYTES", str(8 * 1024 * 1024)))
COLLECTED_IMAGES_DIR = os.environ.get(
    "COLLECTED_IMAGES_DIR", os.path.join(BASE_DIR, "data", "collected_images")
)

# CORS 允许的扩展来源（Chrome 扩展 origin 为 chrome-extension://<id>，MVP 全放开）
CORS_ALLOW_ORIGINS = os.environ.get("CORS_ALLOW_ORIGINS", "*")

# 当前发布的插件版本与下载地址（/v1/plugin-update 与强制更新提示共用）
PLUGIN_VERSION = os.environ.get("PLUGIN_VERSION", "0.1.5")
PLUGIN_DOWNLOAD_URL = os.environ.get(
    "PLUGIN_DOWNLOAD_URL",
    f"http://39.102.73.231:8010/plugin-download/echotik-miaoshou-collector-{PLUGIN_VERSION}-chrome.zip",
)

# 接口最低可用的插件版本：低于该版本的请求一律返回 426 PLUGIN_UPDATE_REQUIRED
MIN_CLIENT_VERSION = os.environ.get("MIN_CLIENT_VERSION", "0.1.5")
