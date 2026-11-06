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

账号级认证使用**认证 Token**（`auth_users` 表维护），扩展在设置页填写后随请求携带：

```
Authorization: Bearer <auth_token>
```

| 角色 | 数据范围 |
|---|---|
| `USER` | 只能读取自己的快照 / 批次 / 商品 / 尝试日志 |
| `ADMIN` | 可读取所有账号的全量数据（`/v1/admin/*` 只读接口） |

- 同一 token 在任意浏览器解析为同一个 canonical `client_id`，因此换浏览器登录后数据自动同步（无需本地存储）。
- 首次认证会为该账号自动创建并绑定一个 `CollectorClient`（`install_id=auth-<user_id>`）。
- 实现对照：`GET /v1/auth/me` 返回当前账号的 `client_id` / `display_name` / `role`。
- 旧客户端仍可携带 `X-Client-Id` + `X-Client-Token`（视为 `USER` 角色）；两者都没有时返回 401。

### 账号配置（在表里填写 token）

服务启动时会自动建表，直接向 `auth_users` 插入即可（`token` 唯一）：

```sql
-- 管理员（可查看所有人的数据）
INSERT INTO auth_users (token, display_name, role, status, created_at)
VALUES ('admin-token-001', '超级管理员', 'ADMIN', 'ACTIVE', datetime('now'));

-- 普通用户（只能看自己的数据）
INSERT INTO auth_users (token, display_name, role, status, created_at)
VALUES ('alice-token-001', 'Alice', 'USER', 'ACTIVE', datetime('now'));
```

可用 sqlite3 直接写入开发库（`created_at` 为必填，未填会触发 NOT NULL 约束）：

```bash
sqlite3 server/data/echotik.db \
  "INSERT INTO auth_users(token, display_name, role, status, created_at) VALUES ('admin-token-001','超级管理员','ADMIN','ACTIVE',datetime('now')),('alice-token-001','Alice','USER','ACTIVE',datetime('now'));"
```

停用账号只需把 `status` 改为非 `ACTIVE`（如 `DISABLED`），该 token 立即失效。

### 旧版安装实例注册（兼容保留）

1. `POST /v1/clients/register` 传入 `install_id` 注册，响应下发 `client_id` + `client_token`。
2. 之后所有接口携带请求头 `X-Client-Id` + `X-Client-Token`。
3. **注册幂等策略**：同一 `install_id` 重复注册返回同一 `client_id`，并**保持原有 token 不轮换**，每次注册响应均返回当前有效 token。

统一响应包装：`{ data, error, request_id }`；`error` 含稳定 `code` / `message` / `retryable`。

## API 摘要

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/auth/me` | 当前认证 Token 对应的账号（canonical client_id / 角色） |
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
| GET | `/v1/admin/clients` | 管理员：全量客户端列表（不含 token） |
| GET | `/v1/admin/batches` / `/v1/admin/batches/{id}` | 管理员：全量批次列表/详情 |
| GET | `/v1/admin/batches/{id}/tasks` | 管理员：任意批次任务明细 |
| GET | `/v1/admin/products` | 管理员：全量商品筛选分页（支持 batch_id/snapshot_id/来源平台） |

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
