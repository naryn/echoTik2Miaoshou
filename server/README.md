# EchoTik Collector Server

EchoTik → TikTok → 妙手 ERP 采集系统的远程服务端。FastAPI + SQLAlchemy 2.x + SQLite（规范文档中的 PostgreSQL 在 MVP 阶段按用户要求替换为 SQLite，模型字段与规范 6.1 保持一致，后续可平滑迁移）。

## 快速启动

```bash
cd server

# 方式一：uv（推荐）
uv venv .venv
uv pip install --python .venv/bin/python -r requirements.txt

# 方式二：标准 venv
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 初始化数据库（可选，服务启动时会自动建表）
.venv/bin/python scripts/init_db.py

# 可选：生成演示数据（1 客户端 / 1 快照 / 20 商品 / 1 批次 5 任务）
.venv/bin/python scripts/seed_demo.py

# 启动服务
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
```

健康检查：`curl http://localhost:8000/healthz`

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DATABASE_URL` | `sqlite:///server/data/echotik.db` | SQLAlchemy 数据库地址 |
| `LEASE_TTL_SECONDS` | `600` | 任务租约默认时长（秒） |
| `CORS_ALLOW_ORIGINS` | `*` | CORS 允许来源（Chrome 扩展 origin 为 `chrome-extension://<id>`） |

## 认证

1. `POST /v1/clients/register` 传入 `install_id` 注册，响应下发 `client_id` + `client_token`。
2. 之后所有接口携带请求头 `X-Client-Id` + `X-Client-Token`。
3. **注册幂等策略**：同一 `install_id` 重复注册返回同一 `client_id`，并**保持原有 token 不轮换**（避免顶掉已在线扩展），每次注册响应均返回当前有效 token。

统一响应包装：`{ data, error, request_id }`；`error` 含稳定 `code` / `message` / `retryable`。

## API 摘要

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/clients/register` | 安装实例注册（install_id 幂等） |
| POST | `/v1/clients/heartbeat` | 客户端心跳 |
| GET | `/v1/clients/me` | 当前客户端详情 |
| GET | `/v1/clients/me/active-task` | 当前租约任务（MV3 重启恢复） |
| POST | `/v1/rank-snapshots` | 创建榜单快照（request_id 幂等） |
| POST | `/v1/rank-snapshots/{id}/entries:upsert` | 批量 upsert 商品+榜单明细（≤200 条/批，非法条目进 rejected） |
| POST | `/v1/rank-snapshots/{id}/finish` | 标记 COMPLETED/PARTIAL/FAILED |
| GET | `/v1/rank-snapshots` | 快照筛选分页 |
| GET | `/v1/products` | 商品筛选/排序/分页（keyword/region/category/ranking_type/快照日期/排名/erp_status） |
| GET | `/v1/products/{id}/rank-history` | 商品榜单历史 |
| POST | `/v1/batches` | 创建批次（idempotency_key 幂等；exclude_already_successful；单客户端单活跃批次，force 可覆盖） |
| GET | `/v1/batches` / `/v1/batches/{id}` | 批次列表/详情（含聚合进度） |
| POST | `/v1/batches/{id}/start\|pause\|resume\|cancel` | 批次状态机控制 |
| POST | `/v1/batches/{id}/retry-failed` | 失败补采批次（仅 FAILED，parent_batch_id 关联） |
| GET | `/v1/batches/{id}/tasks` | 批次任务明细分页 |
| POST | `/v1/tasks/claim` | 排他领取任务（request_id 幂等；过期租约自动回收） |
| POST | `/v1/tasks/{id}/heartbeat` | 租约续约/阶段上报 |
| POST | `/v1/tasks/{id}/events` | 任务事件（event_id 幂等） |
| POST | `/v1/tasks/{id}/result` | 最终结果（attempt_id 幂等；旧 attempt 不覆盖新结果；批次自动聚合完成） |
| GET | `/v1/attempts` | 采集尝试日志筛选分页 |

关键语义：

- 商品按 `(platform, region, external_product_id)` 全局去重。
- 租约过期且状态为 `LEASED/NAVIGATING/PAGE_READY/SUBMITTING` 的任务自动回到 `PENDING` 可被重新领取。
- `UNKNOWN` 不进入普通失败重抓，需人工核实 ERP 侧后处理。
- 批次全部任务进入终态后自动标记 `COMPLETED` 或 `COMPLETED_WITH_ERRORS`。

## 测试

```bash
cd server
.venv/bin/python -m pytest -q
```

测试使用独立临时 SQLite 文件（`tests/conftest.py` 中设置 `DATABASE_URL`），不污染开发数据库。
