# EchoTik → TikTok → 妙手 ERP Chrome 插件采集系统

> **MVP 产品需求与 Codex 工程实施规范**  
> 版本：V1.0 · 2026-11-04  
> 实施目标：仅 Chrome 扩展负责浏览器采集；远程 API + PostgreSQL 负责任务和数据持久化。不使用本地 Python/SQLite，不使用 EchoTik 官方付费 API，不做远程主动控制、多客户端负载调度或验证码自动破解。

---

## 0. 交付目标与必须完成的端到端场景

用户打开已经登录的 EchoTik 榜单，在插件 Side Panel 或网页浮动快捷入口中设置国家/站点、商品分类、榜单类型（日/周/月等）、榜单日期、排名范围和采集数量（例如 200）；点击“获取榜单”。扩展通过已授权、已登录的浏览器页面环境访问 `interface/*.md` 已定义的 EchoTik 页面数据接口，分页获取并解析前 200 个符合条件的商品，上传远程数据库，形成商品主数据和榜单快照。用户选择“创建妙手采集批次”，服务器返回 `batch_id` 和该批次的商品任务。扩展只使用一个受控 TikTok 商品标签页，逐个打开 URL，等待商品详情与妙手官方插件注入的“采集此商品”按钮出现，执行已验证的页面交互，检测提交反馈并尽可能确认商品进入 ERP 采集箱，上报结果；完成一件后按配置间隔执行下一件，直至整个批次到达终态。

遇到 TikTok 验证页面或访问限制，**立即停止领取新商品**，保留当前标签页，提示用户在原页面人工完成验证。扩展检测页面恢复、商品有效和妙手按钮可操作后自动继续，无需二次人工批准；若仍被访问控制拦截则继续等待，不进行自动破解、绕过或高频探测。

### MVP 可验收结果

1. 安装扩展、授权相应网站、完成远程客户端注册；重启 Chrome 后客户端 ID 不变化。
2. 已登录的 EchoTik 页面能按用户选定条件分页获取最多 200 个商品；远程有明确的榜单快照及商品来源。
3. Side Panel 可以查看、搜索、过滤商品和批次，并操作“获取 / 开始 / 暂停 / 继续 / 失败重试 / 指定重抓”。
4. EchoTik 与 TikTok 页面有可拖动、可折叠、可关闭的浮动快捷图标，状态与侧边栏一致。
5. 真实 Chrome + 妙手官方插件完成“打开 1 个真实商品 → 触发采集 → 检查反馈/ERP 采集箱”的 PoC。
6. 200 个商品的批次能够逐个执行；不会一次打开 200 个 Tab，也不会因 Side Panel 关闭而直接丢失进度。
7. 浏览器 Service Worker 被回收、网络短暂中断、页面刷新后能够依靠远程状态和本地检查点恢复，不重复声明成功。
8. 检测验证后暂停；人工验证完成后自动检查并恢复。访问限制持续时不得循环强刷。
9. 远程 PostgreSQL 可查询 `client_id → snapshot_id → batch_id → task_id → attempt_id` 完整关系。

### 不纳入 MVP

- 远程主动下发开始、暂停、重抓等控制命令；远程控制台与复杂权限管理。
- 多客户端统一调度、共享并发池、自动负载均衡。
- EchoTik 官方付费 API；自动登录、破解验证码、代理/指纹/账号轮换等规避平台访问控制的机制。
- 自研妙手采集算法、逆向妙手内部私有 API、改写妙手扩展的代码。
- 复杂选品 AI 评分、视频抓取、刊登自动化、店铺销售分析。

---

## 1. 技术架构与重要约束

```text
┌────────────── Chrome 配置文件（安装用户自有扩展）─────────────┐
│ EchoTik 已登录 Tab       TikTok 固定工作 Tab       妙手插件 │
│      │                     │                         │   │
│ echotik Content Script  tiktok Content Script         │   │
│      └──────────┬──────────┘                         │   │
│          Chrome 自研 MV3 扩展                         │   │
│   Service Worker / Side Panel / Floating Widget         │   │
│   IndexedDB（轻量缓存/检查点） + chrome.storage.local     │   │
└──────────────────────┬───────────────────────────────────┘
                       │ HTTPS、客户端认证、主动上报与领取
┌──────────────────────▼───────────────────────────────────┐
│                   远程 REST API                          │
│   客户端注册 / 榜单快照 / 商品全局去重 / 批次任务 / 任务租约  │
│   采集尝试 / 状态事件 / 心跳 / 幂等写入 / 聚合进度           │
│                     PostgreSQL                          │
└──────────────────────────────────────────────────────────┘
```

**技术建议**：扩展采用 TypeScript + Vue 3 + Vite（可用 WXT 或 CRXJS，选择一个并锁版本），Chrome MV3；远端 FastAPI 或 Go 二选一，PostgreSQL + 数据库迁移（Alembic/Goose 等）；OpenAPI 生成 TypeScript API 类型；Zod 校验页面 API 与远程接口响应；Vitest 单测 + Playwright 浏览器集成测试。

**MV3 事实与约束**：Service Worker 不常驻，空闲后可终止；状态必须持久化，所有事件监听器在顶层同步注册。`chrome.alarms` 用于恢复巡检和周期性同步，不能当成精确的几秒定时器（Chrome 120 起周期最短 30 秒）。秒级任务衔接仅在活动页面/Side Panel 的短生命周期操作中实现；被中断后通过 alarm/onStartup/onUpdated 再协调任务。浏览器完全关闭、电脑休眠或无网络时不能继续采集，恢复后续跑。不可通过人为维持 Service Worker 永不终止来实现核心正确性。

**业务边界**：仅在用户已经有权访问的网页和数据范围内执行。若 EchoTik 页面接口要求额外认证/收费、条款禁止自动化或访问遭到限制，应停止并提示用户核实授权，不应规避访问限制。

**设计选择**：远程 PostgreSQL 是任务与榜单结果的权威存储；插件本地仅保存客户端身份、最近列表缓存、未送达上报的 outbox、当前执行检查点和 UI 偏好。远程并非主动推送命令，插件作为唯一主动执行者。

---

## 2. Chrome 扩展结构与目录

```text
echotik-miaoshou-collector/
├── extension/
│   ├── public/icons/                        # 工具栏/浮动入口图标
│   ├── src/
│   │   ├── background/index.ts               # MV3 事件注册、调度协调
│   │   ├── contents/echotik.ts               # EchoTik 页状态/页面请求桥
│   │   ├── contents/tiktok.ts                # 商品/按钮/验证码 DOM 检测
│   │   ├── contents/floating-widget.ts       # 浮动入口（隔离样式）
│   │   ├── page-bridge/echotik-main.ts       # 最小 MAIN world 请求适配（如必要）
│   │   ├── sidepanel/                         # Vue 主管理界面
│   │   │   ├── pages/Dashboard.vue
│   │   │   ├── pages/RankingCollector.vue
│   │   │   ├── pages/ProductList.vue
│   │   │   ├── pages/BatchTasks.vue
│   │   │   ├── pages/AttemptLog.vue
│   │   │   └── pages/Settings.vue
│   │   ├── popup/                             # 小型状态入口，非核心运行 UI
│   │   ├── modules/echotik/                   # 文档驱动的接口/字段映射适配器
│   │   ├── modules/tiktok/                    # tab 导航、商品就绪检测
│   │   ├── modules/miaoshou/                  # DOM 按钮适配器/成功探针
│   │   ├── modules/runner/                    # 状态机、幂等、检查点
│   │   ├── modules/challenge/                 # 验证检测与恢复判定
│   │   ├── modules/api/                       # 远程 REST 客户端
│   │   ├── modules/storage/                   # IndexedDB + chrome.storage
│   │   ├── shared/types/                      # 合约/枚举/校验器
│   │   └── shared/ui/                         # 通用组件
│   ├── manifest.config.ts
│   └── package.json
├── server/
│   ├── app/api/                               # REST API
│   ├── app/models/                            # DB 模型
│   ├── app/services/                          # 幂等、批次、租约、归档
│   ├── migrations/
│   ├── tests/
│   └── Dockerfile
├── interface/                                  # 用户现有 EchoTik *.md，保留原样
├── docs/
│   ├── adapters/echotik-mapping.md            # 接口文档到代码映射
│   ├── adapters/miaoshou-dom-evidence.md      # 实测选择器、截图和结果
│   ├── architecture.md
│   ├── test-matrix.md
│   └── operations.md
├── docker-compose.yml
├── .env.example
└── README.md
```

### Manifest / 权限设计

- `manifest_version: 3`，`minimum_chrome_version: "120"`（正式锁定前再次验证 sidePanel 和所用 API 的版本支持）。
- `permissions`: `storage`, `tabs`, `scripting`, `sidePanel`, `alarms`；`notifications` 按需启用。避免无用的 `debugger`、`webRequestBlocking`、`cookies` 全量权限。
- `host_permissions`: 仅明确需要的 EchoTik/TikTok 域与用户配置的远端 API 域；妙手 ERP 的域是否需要由 PoC 确定，勿默认申请 `<all_urls>`。
- `content_scripts`: 为 EchoTik/TikTok 各自限定 URL，默认 ISOLATED。只有 EchoTik 页面请求必须使用页面上下文时才采用最小 MAIN world 桥，并严格限制消息内容、origin、nonce、schema。
- `action` 点击打开 Side Panel；`side_panel.default_path` 为 Vue 主面板。
- 浮动入口尽量以 Shadow DOM 隔离样式，避免污染网页；不要遮挡验证码、购买按钮、网站导航。
- 禁止通过远程服务加载任意可执行 JS。扩展代码打包在发布包内，远端仅下发数据和配置。

---

## 3. UI 信息架构与交互规范

### 3.1 插件侧边栏布局（建议宽 400–520px，响应式）

```text
┌───────────────────────────────────────────────┐
│ EchoTik 采集助手   客户端 A001  ●已连接  ⚙   │
│ [概览] [榜单采集] [商品列表] [任务] [日志]   │
├───────────────────────────────────────────────┤
│ 当前任务：美国站 / 热销日榜 / 2026-11-04     │
│ 进度  24 / 200   █████░░░░░  12%           │
│ 成功 21  跳过 1  失败 1  待验证 0  进行中 1 │
│ [暂停] [停止批次] [查看运行页面]            │
├───────────────────────────────────────────────┤
│ 本地浏览器：EchoTik 已登录  TikTok 正常      │
│ 妙手插件：待验证/已检测   远程同步：正常     │
└───────────────────────────────────────────────┘
```

**全局固定区**：扩展标题、客户端简短 ID、远程连接/同步状态、当前运行态、最近一次异常、导航入口。刷新页面/关闭侧栏不应结束正在进行的批次。所有危险动作（停止整个批次、清空缓存）二次确认；暂停可一键执行。

### 3.2 概览页 Dashboard

- 顶部 KPI：今日榜单发现商品数、去重新增数、待 ERP 商品数、成功数、失败数、同步队列数。
- 当前执行卡：批次名称、来源榜单、已处理/总数、成功/跳过/失败/不确定、当前商品标题及 ID、已用时、最后心跳时间。
- 页面环境卡：EchoTik 标签页是否存在/登录是否有效；TikTok 工作 Tab 是否存在；妙手按钮可检测状态；服务器连通性。
- 快捷操作：“采集当前 EchoTik 榜单”“继续上次批次”“打开任务列表”“定位当前 TikTok 商品”。
- 异常条：验证等待、访问限制、网络中断、插件未检测到、任务租约过期等；点击可看具体处理建议。

### 3.3 榜单采集页 RankingCollector（MVP 主入口）

**筛选表单**（字段必须是配置驱动，不可以假定 EchoTik 一定支持所有类型）：

| 条件 | 控件 | 规则 |
|---|---|---|
| 国家/站点 | 单选下拉 | 来源于 EchoTik 接口/映射配置；默认最近一次选择 |
| 一级/二级/三级分类 | 级联选择 | 支持“全部”，受站点范围约束 |
| 榜单类型 | 分组选择 | 日榜、周榜、月榜；接口若支持热销/增长/新品等则动态显示 |
| 榜单日期/周期 | 日期/周期选择 | 根据日/周/月自动切换，展示真实统计周期 |
| 排序维度 | 下拉 | 接口已证实支持的销量、GMV、增长等，不支持则隐藏 |
| 排名范围 | 起始/截止 | 如 1–200；与数量上限一致校验 |
| 采集数量 | 数字输入 | 默认 100（EchoTik：单页 20、最多 5 页；FastMoss：单页 10、最多 10 页），按分页总数限制，不盲目请求 |
| 去重策略 | 下拉 | 保留全部榜单条目 / 仅将未成功 ERP 商品入队 |
| 请求配置 | 折叠区 | 单页数量、页数上限、超时、请求错误退避（仅用于正常故障恢复） |

按钮：“读取当前页面筛选条件”“预览榜单”“获取并保存榜单”“保存筛选预设”。预览不持久化完整任务；获取时显示分页进度、已抓条数、重复条数、错误条数、结束原因。可取消后续分页但保留已保存的有效快照并标注 `PARTIAL`。

**历史榜单子区**：按采集日期、站点、榜单类型、类目、周期筛选；显示快照行数、采集时间、成功/部分完成/失败；支持“查看商品”“重新获取同一榜单条件”“从该快照创建 ERP 批次”。重抓榜单建立新快照，不覆盖旧快照历史。

### 3.4 商品列表 ProductList

表格列：勾选、商品图（若合法返回）、商品名称、TikTok 商品 ID、站点、一级/二级分类、店铺、所属榜单、榜单排名、榜单周期、首次发现时间、最近出现时间、ERP 状态、最近采集时间、失败原因、操作。

顶部过滤：关键词（名称/ID/店铺）、国家、分类级联、榜单类型、快照日期、排名范围、ERP 状态（未采/成功/失败/不确定/已跳过）、采集来源。筛选逻辑在服务端分页执行；支持排序、每页 20/50/100、当前页/筛选结果选择（必须显示将影响的总数量）。

行操作：“打开 TikTok”“查看榜单历史”“加入采集批次”“重抓该商品”“查看日志”。批量操作：“创建 ERP 采集批次”“仅失败重抓”“排除成功商品”“导出 CSV”。CSV 导出采取当前过滤条件并明确数据范围。

**重抓语义**：默认只针对 `FAILED`，`UNKNOWN` 必须先核对 ERP 侧结果；`SUCCESS` 若用户明确要求重抓，需要额外确认“可能在妙手产生重复采集”。不允许将同一商品误判为多个不同商品后重复自动执行。

### 3.5 批次任务页 BatchTasks

分两个层级：批次列表 / 批次详情。

批次表列：批次号、来源快照、创建时间、商品总数、处理进度、成功/跳过/失败/不确定、当前客户端、运行状态、开始/结束时间。过滤：日期范围、状态、站点、分类、来源榜单。

批次详情：顶部状态卡、操作按钮（开始/暂停/继续/停止/失败重试）、进度条、任务子表、按结果过滤、单任务详情侧滑抽屉、错误与恢复事件时间线。

批次状态：`DRAFT`, `READY`, `RUNNING`, `PAUSED`, `WAITING_VERIFICATION`, `RECOVERING`, `COMPLETED`, `COMPLETED_WITH_ERRORS`, `CANCELLED`。

任务状态：`PENDING`, `LEASED`, `NAVIGATING`, `PAGE_READY`, `SUBMITTING`, `SUBMITTED`, `SUCCESS`, `SKIPPED`, `FAILED`, `UNKNOWN`, `WAITING_VERIFICATION`。`SUBMITTED` 不等于 `SUCCESS`。

“运行”前检查：登录态、目标 TikTok Tab、妙手按钮能力和远程状态是否满足。验证未通过时展示具体错误与“重新检测”，不要宣称成功。

### 3.6 执行日志 AttemptLog

筛选：时间、任务/批次、商品 ID、阶段、失败类型、结果、客户端。每条包含 `attempt_id`、目标 URL、DOM 探针结果、提交反馈、远程确认结果、开始/结束时间、耗时及错误码。敏感 Cookie/Token、用户凭证不能写日志；截图需要用户授权与脱敏，并设置保留期限。

### 3.7 设置页 Settings

- 客户端：`client_id`（只读且可复制）、自定义名称、版本、注册时间、最后同步时间、远程地址与连接测试、重新绑定（需认证）。
- EchoTik：识别当前账号登录状态、支持的榜单接口适配器版本、字段映射检查、保存筛选预设。
- TikTok/妙手：工作标签页选择、妙手按钮选择器候选、测试采集流程、结果探针模式。
- 执行参数：任务间隔最小/最大值、单批最多件数、页面等待超时、按钮检测超时、提交结果等待时间、失败最大重试次数（针对暂时网络故障，验证码/访问限制不自动重试）。默认示例用 15–30 秒低频测试；用户原设 3–5 秒不作为安全保证，需由站点允许范围和实际运行结果决定。
- 行为：关闭 Side Panel 后继续任务、异常通知开关、页面打开方式（单固定标签页）、日志保留天数。
- 数据：本地缓存大小、未同步 outbox、手动同步、清理缓存（不可删除远程任务）、导出诊断信息。

### 3.8 浮动快捷入口 Floating Widget（必须实现）

**出现范围**：`echotik.live` 和 `tiktok.com/shop/...` 的支持页面；其他网页不出现。**样式**：48px 圆形主按钮，轻量阴影；支持拖拽、屏幕边缘吸附、折叠成小圆点、关闭当前站点展示、恢复显示（工具栏/设置中）；位置按站点+窗口尺寸保存。移动时不得触发网页原有点击；禁止覆盖验证码或重要交互区域。

**状态表现**：待机灰色、采集中蓝色进度圆环、等待人工验证橙色提醒、失败红点、完成绿色点。颜色需搭配文本/aria-label，不能仅靠颜色传达信息；数字使用当前批次已完成/总数。

**单击行为**：弹出迷你操作面板（不要直接干扰网页）：

```text
┌─────────────────────────────────┐
│ EchoTik 采集助手 · 24/200       │
│ 状态：正在采集  商品 24          │
│ [打开管理台] [暂停] [定位工作页] │
│ 当前页面：EchoTik 日榜           │
│ [从当前榜单创建采集]             │
└─────────────────────────────────┘
```

EchoTik 页面快捷操作：“读取当前榜单条件”“预览/保存当前榜单”“打开榜单配置”；TikTok 页面快捷操作：“显示当前商品任务状态”“跳转任务详情”“暂停任务”，避免在不属于任务的普通页面误触发妙手采集。长按/右键可关闭此站点浮动图标；工具栏入口始终保留。

**实现**：每个页面注入 Shadow DOM 容器；`position: fixed`，高 `z-index` 但不得遮挡站点关键界面，Pointer Events 限制在 Widget 自己区域；与后台通过 message 协议订阅状态，不持有任务权威数据。导航、SPA URL 变化、窗口缩放、插件更新后能正确重挂，且不能重复注入。

### 3.9 UI 页面跳转与操作反馈

- 无数据展示明确空态及下一步建议；无权限展示登录链接与当前站点要求。
- 长请求显示页数、已保存数、预计总数（如果接口提供）、取消按钮。
- 错误提示区别“EchoTik 未登录”“页面接口格式变化”“访问限制”“妙手按钮不可用”“ERP 结果不确定”“远端离线”。
- 用户点击重抓后显示预计任务数以及将跳过/重复处理数，确认后创建新补采批次。
- 操作反馈要来自真实服务端响应，不能前端先假设成功。

---

## 4. EchoTik 已登录页面 API 适配

**本工程不能凭空假设 EchoTik 的真实 URL、签名、请求参数、响应字段。Codex 必须先读取 `interface/*.md`，提取并形成接口映射文档；文档未覆盖的接口先标记待验证，不得伪造。**

### 4.1 适配器合约

```ts
interface RankingQuery {
  region: string;
  categoryId?: string;
  rankingType: 'DAILY' | 'WEEKLY' | 'MONTHLY' | string;
  rankingVariant?: string;
  periodStart?: string;
  periodEnd?: string;
  sortBy?: string;
  startRank: number;
  limit: number;
}
interface RankingPage {
  records: RawRankingItem[];
  hasMore: boolean;
  nextCursor?: string;
  page?: number;
  total?: number;
  sourcePeriod?: { start: string; end: string };
}
interface IEchoTikAdapter {
  capabilities(): Promise<RankingCapabilities>;
  readCurrentPageSelection(tabId: number): Promise<Partial<RankingQuery>>;
  fetchRankingPage(query: RankingQuery, cursor?: string, page?: number): Promise<RankingPage>;
  normalize(item: RawRankingItem, query: RankingQuery): ProductRankingEntry;
}
```

### 4.2 请求执行策略

1. 先检查当前 EchoTik Tab 域名、登录状态和已授权页面接口。
2. 如果接口在扩展侧可以直接使用已获授权的请求，优先用受限 host permissions 和规范 `fetch`；若需要页面环境，请用隔离、最小化的 MAIN World 桥执行同源请求，桥只允许预定义的接口路径与参数，不接受任意 URL/任意 JS 执行。
3. 每页返回值做 schema 校验，核对商品 ID、榜单周期、页码、排名字段；失败时保存原始错误摘要而不是原始 Cookie/凭证。
4. 翻页终止条件：达 `limit`，接口声明无下一页，或者连续返回重复游标/重复页面/空页；避免无限循环。
5. 记录快照的原始过滤条件、请求分页、实际统计周期、`captured_at`、接口版本、完成状态；`daily/weekly/monthly` 必须以 EchoTik 实际返回周期为准。
6. 如果发现 401/403、登录失效、访问限制或反爬验证，停止后续请求，提示用户在浏览器中正常处理；不自动规避认证控制。

### 4.3 商品去重与来源保留

- 商品主键推荐 `(platform, region, external_product_id)`，`external_product_id` 为字符串，避免 JavaScript 64 位整数精度丢失。
- 相同商品出现在不同榜单/日期：商品主表单条；每个榜单快照的排名明细独立保留。
- 允许商品名称、价格、图片 URL、店铺数据随时间变化；原始数据保留快照或必要变化记录。
- 商品 ID 缺失/非合法字符串的条目归入异常记录，不进入 ERP 队列。
- URL 优先使用接口直接给出的合法商品详情 URL；否则依据已验收的 `region + productId` 模板生成。不能假定所有地区 `https://www.tiktok.com/shop/pdp/{id}` 都可访问。

---

## 5. TikTok + 妙手自动采集 Worker

### 5.1 单标签页执行策略

- 维护单一 `worker_tab_id`，默认前台可见；如果 Tab 不存在则创建，存在则 `chrome.tabs.update` 导航。
- 禁止同时处理两个商品；在上一个商品进入明确可继续状态前不得导航下一页。
- `chrome.tabs.onUpdated` + TikTok Content Script 共同负责页面就绪；SPA 路由变化需监测 URL 和商品 ID 变化。
- 目标详情页必须核对 ID 或页面商品证据，若发生地区不可用、下架、登录失效，应记录具体失败类型。

### 5.2 妙手按钮 DOM 适配器（已完成首轮真实 PoC）

必须先通过真实页面检查以下事实：

1. “采集此商品”按钮是否在普通页面 DOM、open Shadow Root、iframe、扩展 Popup 或受保护的内部界面。
2. 从自研扩展 Content Script 是否能定位和触发该按钮；合成 DOM `click()` 是否被妙手接受（不能假设）。
3. 点击之后有哪些可观测的界面状态：加载中、成功 toast、失败 toast、弹框、采集箱提示。
4. 是否存在**经过授权**可核对采集箱的页面或开放 API；若不存在，不得把点击成功直接标成 ERP 成功。
5. 页面重载、插件版本更新、按钮延迟出现时的兼容性。

```ts
interface IMiaoshouAdapter {
  detectAvailability(): Promise<{ available: boolean; evidence: string; reason?: string }>;
  findCollectAction(): Promise<{ supported: boolean; reason?: string }>;
  submitCollectAction(): Promise<{ submitted: boolean; evidence?: string; errorCode?: string }>;
  verifyCollection(productId: string): Promise<
    { state: 'CONFIRMED' | 'NOT_CONFIRMED' | 'UNKNOWN'; evidence?: string }
  >;
}
```

**硬性规定**：如妙手按钮在受保护扩展内部 UI 且没有开放集成方式，不得通过绕过浏览器安全边界来强行控制；PoC 判为 BLOCKED，保留人工点击采集的降级模式，并记录技术限制。适配器选择器采用配置版本 + 多探针 + 可见性/可点击性判断，不使用单一脆弱 CSS 类名，不做盲目的坐标点击。

**2026-11-07 验证记录**：在实际 TikTok PDP 页面中，妙手入口出现在普通页面 DOM 的
`.earth-wxt-collect-panel-button-group` 容器内，实际可点击元素为嵌套的
`<earth-wxt-button class="earth-wxt-button--primary">`，文字为“采集此商品”（可能含不可见字符）。适配器应将文字节点或外层容器归一化为该自定义按钮，并仅发送一次点击序列；不能再叠加 `dispatchEvent('click')` 与 `HTMLElement.click()`，否则会创建重复采集记录。TikTok 页面发生 URL 语义跳转（例如 `/us/pdp/.../{productId}`）后，仍以 URL 中的商品 ID 作为同一任务的就绪证据。

### 5.3 单商品状态流程

```text
PENDING
  -> LEASED -> NAVIGATING -> PAGE_READY -> SUBMITTING
  -> SUBMITTED -> [ERP确认成功] SUCCESS
               -> [确认失败] FAILED
               -> [无法判定] UNKNOWN
异常时:
  -> WAITING_VERIFICATION -> RECOVERING -> 原任务合适阶段
  -> FAILED（已确认失败/超出允许的临时错误重试上限）
  -> SKIPPED（已成功采集或不符合条件）
```

- `SUBMITTED` 仅表示按钮提交有明确证据；没有 ERP 侧成功依据时最多保持 `SUBMITTED` 或最终 `UNKNOWN`，不能直接记 `SUCCESS`。
- 每个状态变更要记录时间与证据。提交前写入 `SUBMITTING` 检查点；如果页面/插件进程突然终止，先查询 ERP 是否已导入；若无法查询，标记 `UNKNOWN`，防止重复点击。
- 服务端保存 `task_id`、`attempt_id`、`lease_token`，执行结果采用幂等 key。旧租约上报不能覆盖新尝试结果。

### 5.4 频率、页面加载和恢复

- 任务之间的时间间隔由配置控制，必须从上一任务结束后开始计时，不是只等待导航完成。
- 初始建议使用保守的测试间隔，例如 15–30 秒；原设 3–5 秒可保留为可配置输入但**不能声称可规避反爬**。不可自动提高频率到突破访问限制。
- 页面超时可记录失败并按明确规则有限重试；遇到验证码、429、封禁或明确访问限制立即进入等待，不继续对同类商品频繁重试。
- 避免无意义的页面频繁刷新；若当前页面明显未恢复，则等待用户完成验证。

### 5.5 验证弹窗与自动继续（用户已确认规则）

**检测信号**：常见验证 iframe/弹窗 DOM 结构、页面跳转至 challenge 页面、访问限制提示、服务端限制响应以及“商品详情缺失但出现安全验证”组合证据。识别规则必须可更新测试，不能只找“验证码”三个汉字。

进入 `WAITING_VERIFICATION`：立即暂停新任务领取；保持该 TikTok Tab；扩展 Side Panel、浮动入口显示“等待人工验证”；必要时系统通知用户。**不自动求解滑块或绕过挑战**。

人工在**同一个 Chrome 标签页**完成验证。TikTok Content Script 监听 DOM/路由变化，检测验证消失且目标商品内容恢复、妙手按钮状态正常后进入 `RECOVERING`。恢复时按当前阶段检查是否已经提交妙手；可明确判断未提交则从安全阶段继续；无法判断则转为 `UNKNOWN` 并跳过重复提交。完成恢复检查后**自动继续**，不需要用户点击“批准/继续”。

持续访问受限则维持 `WAITING_VERIFICATION`，不执行自动绕过或无限探测。网络断连时暂停新任务，恢复后先同步本地 outbox 与租约状态再行动。

---

## 6. 远程数据模型（PostgreSQL）

> 主键可统一 `UUID`/ULID；时间统一 `timestamptz` UTC 入库、前端按用户时区显示；不应把排行榜自然日等同于抓取时间。

### 6.1 表与核心字段

| 表 | 关键字段 | 说明 |
|---|---|---|
| `collector_clients` | `client_id PK`, `display_name`, `install_id`, `status`, `registered_at`, `last_seen_at`, `extension_version` | 插件安装实例注册；凭证单独管理 |
| `products` | `id PK`, `platform`, `region`, `external_product_id TEXT`, `title`, `shop_id`, `image_url`, `first_seen_at`, `last_seen_at`, `raw_excerpt JSONB` | UNIQUE(platform,region,external_product_id) |
| `categories` | `id`, `source`, `region`, `external_category_id`, `parent_id`, `name`, `level` | 分类树/映射 |
| `rank_snapshots` | `snapshot_id PK`, `client_id FK`, `region`, `ranking_type`, `ranking_variant`, `category_id`, `period_start`, `period_end`, `capture_started_at`, `capture_finished_at`, `status`, `filter_json`, `total_entries` | 保存每一次榜单获取 |
| `rank_entries` | `snapshot_id FK`, `product_id FK`, `rank_position`, `sales`, `gmv`, `metrics_json`, `raw_excerpt`, `observed_at` | UNIQUE(snapshot_id,product_id)；保留具体榜单指标 |
| `collection_batches` | `batch_id PK`, `client_id FK`, `source_snapshot_id FK NULL`, `status`, `created_at`, `started_at`, `finished_at`, `config_json`, `summary_json` | 一次选中的 ERP 采集批次 |
| `collection_tasks` | `task_id PK`, `batch_id FK`, `product_id FK`, `status`, `attempt_count`, `claimed_by_client_id`, `lease_token`, `lease_expires_at`, `last_error_code`, `updated_at` | UNIQUE(batch_id,product_id) |
| `collection_attempts` | `attempt_id PK`, `task_id FK`, `client_id FK`, `started_at`, `finished_at`, `stage`, `result`, `evidence_json`, `error_code`, `elapsed_ms` | 多次采集尝试历史 |
| `task_events` | `event_id PK`, `task_id FK NULL`, `batch_id FK`, `client_id FK`, `event_type`, `payload_json`, `occurred_at`, `received_at` | 状态审计与幂等上报 |
| `client_heartbeats` | `client_id`, `observed_at`, `browser_state`, `active_batch_id`, `active_task_id`, `sync_pending_count` | 可按保留策略汇总/归档 |

可在业务域需要时新增 `workspace_id`，但 MVP 不实现多租户功能。单商品的 ERP 历史成功与否要附带目标 ERP 账号/工作区的去重作用域，避免不同妙手账号误共用采集成功标记。

### 6.2 客户端身份

- 第一次安装生成 `install_id` UUID 并写 `chrome.storage.local`，注册后拿到 `client_id` 与受限客户端凭证。
- `client_id` 不等于权限；服务端必须校验凭证、客户端与批次归属。
- 插件更新、Chrome 重启不更改 ID。清理插件数据/重装需引导重新绑定，不能擅自冒用旧客户端身份。
- Token/凭证只存扩展隔离存储，绝不注入网页 MAIN world、写日志或传给 EchoTik/TikTok。

### 6.3 幂等与并发

- 服务端采用事务：客户端创建快照 `request_id` 幂等、批次创建 `idempotency_key` 幂等、任务 claim 排他、结果 `attempt_id/event_id` 去重。
- 一个客户端 MVP 同时只运行一个 ERP 批次；一个批次下同一个商品不重复创建任务。
- `UNKNOWN` 不能由一般失败重试自动重新领取；必须先完成目标 ERP 采集箱确认或用户明确人工选择强制重抓。
- 批次完成条件：所有任务进入 `SUCCESS/SKIPPED/FAILED/UNKNOWN` 等终态（若业务定义 `UNKNOWN` 需人工处理，则标为完成有待核实项）。

---

## 7. 远程 REST API 合约（MVP）

> 所有写接口须鉴权；返回统一 `{ data, error, request_id }` 结构；错误有稳定 `code`、`message`、`retryable`。分页使用游标或明确页码；批量上传每次限定容量，避免单一 200 条大请求失效。

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/v1/clients/register` | 安装实例注册、绑定 `client_id` |
| POST | `/v1/clients/heartbeat` | 状态/版本/任务进度上报 |
| GET | `/v1/clients/me` | 当前客户端详情与权限 |
| POST | `/v1/rank-snapshots` | 创建榜单快照和参数 |
| POST | `/v1/rank-snapshots/{id}/entries:upsert` | 分页批量上传商品与榜单明细（幂等） |
| POST | `/v1/rank-snapshots/{id}/finish` | 标记快照完成/部分完成/失败 |
| GET | `/v1/rank-snapshots` | 历史快照查询与筛选 |
| GET | `/v1/products` | 商品服务端分页/筛选/排序 |
| GET | `/v1/products/{id}/rank-history` | 商品榜单历史 |
| POST | `/v1/batches` | 从快照/选择的商品 ID 创建批次 |
| GET | `/v1/batches` | 批次列表 |
| GET | `/v1/batches/{id}` | 批次详情和聚合进度 |
| POST | `/v1/batches/{id}/start` | 本客户端发起开始 |
| POST | `/v1/batches/{id}/pause` | 本客户端发起暂停 |
| POST | `/v1/batches/{id}/resume` | 本客户端发起继续 |
| POST | `/v1/batches/{id}/cancel` | 本客户端取消 |
| POST | `/v1/batches/{id}/retry-failed` | 创建补采批次或计划失败重试 |
| GET | `/v1/batches/{id}/tasks` | 批次任务明细 |
| POST | `/v1/tasks/claim` | 当前客户端领取下一件，带 batch_id |
| POST | `/v1/tasks/{id}/heartbeat` | 延长合法租约/上报阶段 |
| POST | `/v1/tasks/{id}/events` | 记录阶段与验证状态 |
| POST | `/v1/tasks/{id}/result` | 按 attempt_id 幂等提交最终结果 |
| GET | `/v1/clients/me/active-task` | MV3 重启后恢复当前任务 |
| GET | `/v1/attempts` | 采集尝试日志/错误筛选 |

**核心示例**：

```json
POST /v1/batches
{
  "client_id": "c_...",
  "snapshot_id": "snap_...",
  "product_ids": ["p_..."],
  "exclude_already_successful": true,
  "interval_seconds": { "min": 15, "max": 30 },
  "idempotency_key": "uuid"
}
```

```json
POST /v1/tasks/claim
{
  "batch_id": "batch_...",
  "client_id": "c_...",
  "request_id": "uuid"
}
```

```json
{
  "data": {
    "task_id": "task_...",
    "attempt_id": "attempt_...",
    "lease_token": "opaque-short-lived-token",
    "product": { "external_product_id": "1732052189676081387", "region": "US", "detail_url": "https://www.tiktok.com/shop/pdp/1732052189676081387" }
  },
  "error": null,
  "request_id": "uuid"
}
```

服务端应独立保存每次尝试的 checkpoint，不要依赖浏览器单方面声称“已完成”。如果下一件被领取前发生服务端断连，扩展必须先确认上一个任务上报落库或转入可核实状态。

---

## 8. 运行、暂停、重抓与自动恢复算法

### 8.1 运行循环（逻辑伪代码，非 Service Worker 常驻死循环）

```ts
async function runNext(batchId: string) {
  if (!(await ensureEligibleToRun(batchId))) return;
  const task = await api.claimTask(batchId);
  if (!task) { await finalizeBatchIfTerminal(batchId); return; }

  await checkpoint(task, 'NAVIGATING');
  const tab = await ensureSingleTikTokTab(task.product.detail_url);
  const page = await waitForExpectedProduct(tab, task.product.external_product_id);
  if (page.state === 'CHALLENGE' || page.state === 'ACCESS_RESTRICTED') {
    await markWaitingVerification(task);
    return;
  }
  if (page.state !== 'READY') { await recordFailure(task, page.reason); return; }

  const miaoshou = await detectMiaoshouAction(tab);
  if (!miaoshou.available) { await markBlockedOrFailed(task, miaoshou.reason); return; }

  await checkpoint(task, 'SUBMITTING');
  const submission = await submitMiaoshouCollection(tab);
  const confirmation = await verifyCollectionOrMarkUnknown(task, submission);
  await reportResultIdempotently(task, confirmation);

  if (await ensureEligibleToRun(batchId)) {
    await scheduleNextViaLivePageCoordinatorAndPersistedCheckpoint(batchId);
  }
}
```

> 这里只展示逻辑流程：实际实现必须通过 Tab/Content Script 消息和持久化状态串联，不能把任务生命周期完全放在一次未受控的异步 `runNext()` 中，更不能假定 Side Panel 始终打开。

### 8.2 控制语义

- **开始**：仅从 `READY/PAUSED` 且通过环境检测后开始；重复点击幂等。
- **暂停**：停止领取新任务，已在 `SUBMITTING` 的任务须完成明确结果或标记 `UNKNOWN`；不能让浏览器导航造成重复提交。
- **继续**：先读取服务端 active task、比对当前 Tab 和检查点，再决定恢复阶段。
- **取消**：终止后续领取，不抹掉历史；对正在提交的任务先完成结果核实。
- **失败重抓**：新建补采批次，关联原批次（`parent_batch_id`），默认只包含 `FAILED`。
- **单条重抓**：展示过去结果与重复风险；`SUCCESS` 必须二次确认；`UNKNOWN` 必须先核对 ERP 采集箱。
- **重新抓取榜单**：始终创建新的 `rank_snapshot`，不覆盖已有历史。

### 8.3 恢复入口

`runtime.onStartup`、`runtime.onInstalled`、`alarms.onAlarm`、`tabs.onUpdated`、`tabs.onRemoved`、Content Script 页面就绪消息、Side Panel 打开时均调用 `reconcile()`；需要去重锁，避免重复执行。

`reconcile()`：读取 `client_id` → 拉取服务器 active task → 检查本地 `worker_tab_id` 与阶段 → 检查过期租约、上一提交是否未知 → 决定恢复、保持等待或终止。所有可能产生副作用的操作（特别是妙手点击）必须通过执行阶段 + attempt 幂等控制。

---

## 9. 本地存储与远程同步策略

### chrome.storage.local（少量持久状态）

```json
{
  "client_id": "c_...",
  "install_id": "uuid",
  "server_url": "https://api.example.com",
  "worker_tab_id": 123,
  "active_batch_id": "batch_...",
  "active_task_id": "task_...",
  "runner_stage": "PAGE_READY",
  "widget_preferences_by_origin": {},
  "last_filters": {},
  "recovery_check_at": "2026-11-04T10:00:00Z"
}
```

### IndexedDB（本地辅助缓存）

Stores: `recent_products`, `snapshot_previews`, `outbox_events`, `recent_task_checks`, `ui_cached_queries`。每条 outbox 包含唯一 `event_id`、`client_id`、`task_id`、创建时间、重试次数、状态。服务端幂等成功后再删除。

注意 IndexedDB 容量和用户清除数据情况；远程 PostgreSQL 为权威，不依赖浏览器作为唯一历史存储。避免跨源网页 Content Script 直接读扩展 IndexedDB（其 Web API 默认属于页面来源）；统一经扩展侧存储服务读写。

同步优先级：结果/验证状态 > 批次进度 > 榜单数据 > 非关键统计；当服务端无法上报执行结果时不领取下一件，防止不可恢复的重复采集。

---

## 10. 安全、稳定性及合规要求

- 所有服务端 API 必须 HTTPS，客户端凭证最小权限；远程请求校验 Origin/客户端身份/数据归属，启用速率限制、审计和密钥撤销。
- 页面桥接要防消息伪造、任意 URL 调用、信息泄漏；`window.postMessage` 采用固定协议 + nonce + 严格 origin 与 schema 验证。网页数据视为不可信，不允许注入脚本代码。
- 不读取或上传 EchoTik/TikTok/妙手 Cookie、Token、浏览器密码到远端；使用已登录页面的合法现有能力。
- 严格禁止自动破解验证码、代理轮换规避封禁、指纹伪装、绕过登录或付费权限。发现站点访问限制应暂停并人工处理。
- 任务重试要有明确的 `retryable` 分类；验证/429/访问拒绝不是“换策略自动继续”的信号。
- 异常日志脱敏、可配置保留期；默认不自动上传完整网页 HTML、用户截图或敏感 Cookie。
- 远程数据库每日备份，迁移可回滚；服务端恢复后扩展的 outbox 可幂等补传。
- 分类/日期/商品 ID 的所有服务端字段验证必须到位，避免跨批次数据污染。

---

## 11. PoC 前置门槛（开发顺序不能颠倒）

### PoC-A：EchoTik 页面 API

输入用户提供的 `interface/*.md`，输出以下可核查结果：真实接口路径、请求方法、参数映射、分页方法、登录会话要求、日/周/月榜类型、分类接口、完整样本响应和字段映射；展示 1 页真实合法数据并提取商品 ID；如果接口文档缺失则明确阻塞，保留可替换 Mock，不可以伪造生产返回。

### PoC-B：妙手插件 DOM 采集

使用真实 Chrome + 妙手插件 + 1 个可打开的 TikTok 商品，记录：按钮所在 DOM 层级、定位策略、程序触发是否奏效、提交过程、结果反馈、ERP 采集箱核对途径及截图（必要时脱敏）。**未通过此 PoC，不得宣称无人值守批量导入已实现。**

### PoC-C：验证与 MV3 生命周期

以可控的模拟挑战页面测试 WAITING_VERIFICATION → 人工解除 → 自动恢复；Service Worker 强制停止/重启后正确读取远端任务。真实网站上出现限制时仅观察和暂停，不制造验证码挑战或探测绕过方式。

---

## 12. 工程实施迭代（Codex 按阶段执行）

### Phase 0 — 需求约束与接口核对

- 扫描 `interface/*.md`；生成 `docs/adapters/echotik-mapping.md`，列出每个筛选条件的真实接口支持/未支持情况。
- 完成妙手真实 DOM PoC 和结果探针；记录可用与不可用边界。
- 形成不可替换字段清单：`client_id`, `snapshot_id`, `batch_id`, `task_id`, `attempt_id`, `event_id`。

### Phase 1 — 远程数据层与 API

- PostgreSQL schema / migrations / 基础数据约束。
- 客户端注册/认证、商品与榜单快照、批次创建/任务领取/心跳/结果 API。
- OpenAPI 文档、单测、幂等和并发冲突测试。

### Phase 2 — Chrome MV3 底座

- 初始化 Vue3/TS/Vite 扩展，Manifest 权限最小化。
- Side Panel、工具栏、客户端注册、IndexedDB/outbox、扩展消息协议、生命周期恢复入口。
- 浮动图标在 EchoTik/TikTok 上可拖拽、折叠和打开管理台。

### Phase 3 — EchoTik 榜单 UI 与抓取

- 配置化筛选表单、当前页面条件读取、分页抓取、断点/部分完成、快照历史。
- 远程商品列表服务端分页、分类筛选、去重与榜单历史。

### Phase 4 — TikTok 妙手 Worker

- 单标签页 worker、任务租约与检查点、页面就绪、妙手按钮适配器、提交/确认。
- 错误码、验证暂停/自动恢复、暂停继续取消、重抓机制。

### Phase 5 — 测试、打包和运维

- 所有 UI 态、异常态、断网恢复、重复执行、权限失败、跨页切换、插件生命周期测试。
- 插件构建 ZIP（开发者加载目录及可选上架包）、远程 Docker Compose、一键初始化/升级文档、回滚手册。

---

## 13. 验收用例矩阵

| 编号 | 场景 | 必须结果 |
|---|---|---|
| T01 | 首次安装与注册 | 生成并保存稳定 client_id，远端可查询 |
| T02 | Chrome 重启 | client_id 保持不变，主动恢复检查 |
| T03 | 获取日榜前 200 | 正确翻页，记录实际总数、分类、周期与排名 |
| T04 | 同商品同时出现在周/月榜 | 商品主表一条、不同快照明细完整 |
| T05 | 修改筛选条件 | UI 与实际请求一致，清晰校验无效组合 |
| T06 | 创建批次 200 条 | 创建 200 或扣除规则跳过后的明确数量，不隐性丢失 |
| T07 | 单个 TikTok 商品 | 打开真实详情、检测按钮、可核对 ERP 结果 |
| T08 | 任务执行中关闭 Side Panel | 采集状态正确，不以面板生命周期为运行条件 |
| T09 | Service Worker 被终止 | 重唤醒后不重复点击、不覆盖历史结果 |
| T10 | 验证弹窗出现 | 停止领取新任务，当前页保留 |
| T11 | 用户手动完成验证 | 满足恢复判据后自动继续，无需额外批准 |
| T12 | 访问限制仍然存在 | 持续等待，禁止不断刷新或请求 |
| T13 | 远程断网 2 分钟 | 缓存事件，停止领取新任务；恢复后幂等同步 |
| T14 | 点击成功但 ERP 结果不可查 | `UNKNOWN` 或 `SUBMITTED`，不能冒充成功 |
| T15 | 批次中途暂停/继续 | 不跳单、不重新导入已完成商品 |
| T16 | 失败重抓 | 只创建应重抓任务，关联源批次 |
| T17 | 单个成功商品强制重抓 | 明确二次确认，记录人为强制原因 |
| T18 | 浮动 Icon 拖拽/关闭 | 状态正确、不会重复注入、位置保存 |
| T19 | 两个客户端上报同商品 | 全局商品去重，来源客户端与快照各自保留 |
| T20 | 任务结束 | 成功/跳过/失败/未知数之和等于批次实际任务数 |

**验收判定**：核心 T01–T18 全通过才能宣称 MVP 可用；若 PoC-B 无法确认 ERP 真实采集成功，应明确标注“浏览器采集动作自动化已完成，ERP 成功确认待集成”，而非对外声称完整自动化。

---

## 14. Codex 开发执行指令（可直接复制）

```text
你是该工程的全栈技术负责人。严格遵照仓库根目录的
EchoTik_Miaoshou_Chrome_Extension_MVP_Implementation.md 实现 MVP。

先检查仓库的 interface/*.md，整理真实 EchoTik 接口契约；不得猜造 URL、请求签名、响应字段。
先做两个验证：EchoTik 已登录页面合法请求可用；妙手官方插件的
“采集此商品”按钮能由自研 Content Script 定位、触发并确认结果。
任何未经验证的妙手私有接口不得使用。

工程采用 Chrome Manifest V3 + TypeScript + Vue3 Side Panel，
网页浮动快捷入口；远端 REST API + PostgreSQL。绝不使用本地
Python、SQLite 或远程主动控制。一个客户端只运行一个 ERP 批次，
一个 TikTok 工作 Tab，逐个商品处理；支持筛选、分类、榜单快照、
商品列表、批次任务、日志、失败重抓、暂停继续和验证自动恢复。

状态机和幂等保障先于批量运行功能；Service Worker 可以被终止，
所有任务必须能从数据库与本地检查点恢复；SUBMITTED 不等于 SUCCESS。
遇到验证码/限制只暂停与人工验证，不自动破解或规避限制。

按 Phase 0–5 分阶段执行，每阶段运行单测、集成测试并更新 docs。
真实站点不具备访问或会话时使用 mock 实现并明确标注待验收，
不可声称外部环境已经验证。最终交付扩展可加载构建产物、
远程部署配置、数据库迁移、OpenAPI、测试报告、安装和故障排查文档。
```

---

## 15. 官方技术参考与后续核对

- Chrome Extension MV3 Service Worker lifecycle：<https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle>
- Chrome Content Scripts & Isolated/Main World：<https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts>
- Chrome Side Panel API：<https://developer.chrome.com/docs/extensions/reference/api/sidePanel>
- Chrome Storage / IndexedDB：<https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies>
- Chrome Runtime Messaging：<https://developer.chrome.com/docs/extensions/develop/concepts/messaging>

**重要未解决依赖**：当前未提供实际 `interface/*.md` 内容，也未提供妙手按钮的真实 DOM 结构和 ERP 成功信号。工程文档已将这两项列为 Phase 0 必须验证的阻塞项，不能从示例 URL 推导所有真实接口行为。
