# EchoTik → TikTok → 妙手 ERP Chrome 插件采集系统

Chrome MV3 扩展负责浏览器内采集（EchoTik 榜单抓取 + TikTok 页面妙手采集触发），远程 FastAPI 服务负责任务与数据持久化。**当前远程端使用 SQLite**（MVP 阶段，后续可平滑迁移 PostgreSQL）。

规范文档：[docs/EchoTik_Miaoshou_Chrome_Extension_MVP_Implementation.md](docs/EchoTik_Miaoshou_Chrome_Extension_MVP_Implementation.md)

## 目录结构

```text
├── extension/          # Chrome MV3 扩展（WXT + TypeScript + Vue3）
│   ├── src/entrypoints/    # background / content scripts / sidepanel / popup
│   ├── src/modules/        # api、storage、echotik、tiktok、miaoshou、runner、challenge
│   └── src/shared/         # 合约类型、消息协议
├── server/             # 远程 REST API（FastAPI + SQLAlchemy + SQLite）
│   ├── app/                # api / models / services
│   ├── scripts/            # init_db / seed_demo
│   └── tests/              # pytest（29 用例）
└── docs/
    ├── interface/          # EchoTik 真实接口文档（契约来源，勿改）
    ├── examples/           # 接口真实响应示例
    └── adapters/           # 接口→代码映射文档
```

## 快速启动

### 1. 远程服务（默认 SQLite，端口 8000）

```bash
cd server
uv venv .venv && uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
# 可选演示数据：.venv/bin/python scripts/seed_demo.py
```

测试：`.venv/bin/python -m pytest`（29 passed）

### 2. Chrome 扩展

```bash
cd extension
npm install
npm run build        # 产出 .output/chrome-mv3
```

Chrome → `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选择 `extension/.output/chrome-mv3`。
扩展内「设置 → 远程地址」默认 `http://localhost:8000`。

测试：`npm test`（Vitest）｜类型检查：`npm run typecheck`

## 功能地图

状态说明：✅ 已完成并有自动化验证 ｜ 🟡 已实现，待真实站点/真实账号校准 ｜ ⛔ 未开始

### EchoTik 榜单采集

| 能力 | 状态 | 位置 |
| --- | --- | --- |
| 三榜单（热销/热推/新品）+ 商品库抓取、类目三级级联、排序维度按变体收敛 | ✅ | [adapter.ts](extension/src/modules/echotik/adapter.ts)、[RankingCollector.vue](extension/src/entrypoints/sidepanel/pages/RankingCollector.vue) |
| 分页抓取 + 每页随机 2–5 秒限速 + 取消 | ✅ | [adapter.ts](extension/src/modules/echotik/adapter.ts) |
| 会员/访客权限限制识别，保留已抓数据并以 `PERMISSION_LIMIT` 结束（PARTIAL） | ✅ | [adapter.ts](extension/src/modules/echotik/adapter.ts)、[echotik-main.content.ts](extension/src/entrypoints/echotik-main.content.ts) |
| 快照明细上传（`{value,raw}` → 数值转换）、快照历史/筛选/预设 | ✅ | [background.ts](extension/src/entrypoints/background.ts)、[RankingCollector.vue](extension/src/entrypoints/sidepanel/pages/RankingCollector.vue) |
| 站点切换、周榜/月榜周期真机校准 | 🟡 | 依赖 EchoTik 真实页面会话 |

### 批次与任务

| 能力 | 状态 | 位置 |
| --- | --- | --- |
| 从快照/商品列表建批、幂等键、单客户端单活跃批次约束 | ✅ | [batch_service.py](server/app/services/batch_service.py) |
| 启动/暂停/停止/失败重试，**CANCELLED 可重新开始**（重置未完成任务） | ✅ | [batch_service.py](server/app/services/batch_service.py)、[BatchTasks.vue](extension/src/entrypoints/sidepanel/pages/BatchTasks.vue) |
| 租约领取（lease_token/幂等键）、批量跳过重复、`maybe_finalize_batch` 收敛 | ✅ | [lease_service.py](server/app/services/lease_service.py) |
| 去重：已采集商品不再开 TikTok 页，任务标 `SKIPPED` + “重复抓取”，支持单条「重新抓取」 | ✅ | [lease_service.py](server/app/services/lease_service.py)、[BatchTasks.vue](extension/src/entrypoints/sidepanel/pages/BatchTasks.vue) |
| 批次响应携带榜单信息（站点/榜单/类型/类目/日期/快照条数） | ✅ | [routes_batches.py](server/app/api/routes_batches.py)、[BatchTasks.vue](extension/src/entrypoints/sidepanel/pages/BatchTasks.vue) |
| 批次行「商品」/详情「查看商品」→ 商品列表自动带批次+站点+榜单过滤 | ✅ | [BatchTasks.vue](extension/src/entrypoints/sidepanel/pages/BatchTasks.vue)、[ProductList.vue](extension/src/entrypoints/sidepanel/pages/ProductList.vue) |
| 每轮 upsert 失败/成功的 attempt 证据上报 | 🟡 | 上报字段已修正为 `evidence`，待真机确认落库 |

### 商品列表

| 能力 | 状态 | 位置 |
| --- | --- | --- |
| 本地商品库（IndexedDB）筛选：关键词/站点/类目/榜单/日期/排名 + 排序分页 + CSV 导出 | ✅ | [ProductList.vue](extension/src/entrypoints/sidepanel/pages/ProductList.vue) |
| **按批次过滤**：取批次任务涉及商品外部 ID 与本地商品求交集 | ✅ | [background.ts](extension/src/entrypoints/background.ts) |
| **单件商品一键采集**：解析服务端商品 → 建单商品批次（强制重抓 `FORCE_RECOLLECT`）→ 启动并领取 | ✅ | [background.ts](extension/src/entrypoints/background.ts)、[batch_service.py](server/app/services/batch_service.py) |

### TikTok + 妙手 Worker

| 能力 | 状态 | 位置 |
| --- | --- | --- |
| 固定单个 TikTok 工作 Tab（pinned/激活），任意站点回退 `https://www.tiktok.com/shop/pdp/{id}` | ✅ | [tab-manager.ts](extension/src/modules/tiktok/tab-manager.ts) |
| 单商品状态机（LEASED→NAVIGATING→PAGE_READY→SUBMITTING→SUBMITTED→WAITING_VERIFICATION） | ✅ | [state-machine.ts](extension/src/modules/runner/state-machine.ts)、[background.ts](extension/src/entrypoints/background.ts) |
| 运行器串行锁 + 幂等状态转换（修复 tabs.onUpdated / pageReady 重入导致的非法跳变） | ✅ | [background.ts](extension/src/entrypoints/background.ts) |
| 地区不可用（“此国家或地区未提供的商品”）自动暂停批次 | ✅ | [tiktok.content.ts](extension/src/entrypoints/tiktok.content.ts)、[background.ts](extension/src/entrypoints/background.ts) |
| 妙手「采集此商品」按钮适配：不可见字符归一化、嵌套 `earth-wxt-button` 目标解析、单次点击提交 | ✅ | [adapter.ts](extension/src/modules/miaoshou/adapter.ts) |
| 验证/访问限制识别（challenge）与人工介入恢复 | 🟡 | [detector.ts](extension/src/modules/challenge/detector.ts)、[tiktok.content.ts](extension/src/entrypoints/tiktok.content.ts) |
| 妙手采集成功确认 | 🟡 | 无授权核对途径时保持 `UNKNOWN`，不宣称无人值守批量导入 |
| 浮动快捷入口（圆形 icon + 扇形菜单 + 进度 + 悬停收起） | ✅ | [floating-widget.content.ts](extension/src/entrypoints/floating-widget.content.ts) |

### 工程

| 能力 | 状态 |
| --- | --- |
| FastAPI + SQLAlchemy + SQLite，pytest 29 项 | ✅ |
| 扩展 WXT + Vue3 + TS，Vitest 59 项、`tsc --noEmit`、`wxt build` | ✅ |
| SW 重启后 reconcile 检查点恢复 | 🟡 逻辑已实现，待真机长跑验证 |
| 打包发布 / PostgreSQL 迁移 / 多客户端压测 | ⛔ |

## 未完成待办

### P0（阻塞端到端验收）

- **持续兼容妙手插件界面变化**：已在真实页面确认入口位于普通 DOM 的 `.earth-wxt-collect-panel-button-group > earth-wxt-button`；探测失败时证据会输出“页面是否含采集字样 + shadow 宿主数 + iframe 域名”。
- **扩展最终 ERP 成功确认**：已验证 US 商品 → TikTok 详情页 → 点击「采集此商品」可进入妙手公用采集箱；仍需授权回执，才能自动标记最终成功。
- **妙手成功确认机制**：若无法读取 ERP 授权回执，需补人工确认入口或核对方案，保持 `UNKNOWN` 语义。
- **验证 challenge 误判修复**：隐藏 captcha 容器已按可见性过滤（`last_probe_evidence` 写入 checkpoint），需真机确认 `runner_stage` 能进入 `PAGE_READY/SUBMITTING`。

### P1

- 若按钮确认在跨域 iframe：新增 ERP 域 `all_frames` content script 或改走 ERP 站点采集路径。
- 周榜/月榜周期、站点切换、商品库 `dateRange` 的真机校准。
- 任务详情 UI 展示 attempt `evidence`（当前仅落库）。
- `WAITING_VERIFICATION` 人工完成后自动继续的真机验证。

### P2

- 扩展打包发布（CRX/商店）、多客户端并发压测、PostgreSQL 迁移。

## 开发提示

- 修改扩展后必须在 `chrome://extensions` 点「重新加载」，解包扩展不会自动热更新。
- 通过 SSH 推送仓库：`git@github.com:naryn/echoTik2Miaoshou.git`。
