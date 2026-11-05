# EchoTik 妙手采集助手（Chrome MV3 扩展）

EchoTik 榜单采集 → TikTok 商品页 → 妙手 ERP「采集此商品」联动的浏览器端扩展。
技术栈：WXT + TypeScript + Vue 3（Side Panel/Popup）+ zod + Vitest，Manifest V3（minimum_chrome_version 120）。

## 安装依赖

```bash
cd extension
npm install
```

## 开发 / 构建

```bash
npm run dev       # 开发模式（watch + 热更新，产出 .output/chrome-mv3-dev）
npm run build     # 生产构建（产出 .output/chrome-mv3）
npm test          # Vitest 单测
npm run typecheck # TypeScript 类型检查
```

## 加载到 Chrome（Load Unpacked）

1. 打开 `chrome://extensions`，开启右上角「开发者模式」
2. 点击「加载已解压的扩展程序」，选择 `extension/.output/chrome-mv3`
3. 点击工具栏图标打开 Popup，再点「打开管理台」进入 Side Panel
4. 首次安装会自动生成 `install_id` 并向远程服务注册换取 `client_id`/`client_token`

## 远程 API 配置

- 默认 base URL：`http://localhost:8000`（可在 Side Panel → 设置 页修改并测试连接，保存于 `chrome.storage.local.server_url`）
- 统一响应 `{ data, error, request_id }`；鉴权头 `X-Client-Id` / `X-Client-Token`
- 端点契约见 `docs/EchoTik_Miaoshou_Chrome_Extension_MVP_Implementation.md` §7

## 目录结构

```
src/
  entrypoints/
    background.ts            # MV3 SW：事件注册/客户端注册/reconcile/Runner 调度/outbox
    echotik.content.ts       # EchoTik 页 ISOLATED 脚本（登录检测 + 页面桥客户端）
    echotik-main.content.ts  # EchoTik MAIN world 最小请求桥（nonce+origin+路径白名单）
    tiktok.content.ts        # TikTok Shop 页：商品就绪/验证检测/妙手提交/SPA 监测
    floating-widget.content.ts # Shadow DOM 浮动 Widget（拖拽/吸附/折叠/状态色）
    sidepanel/               # Vue 3 管理台外壳（六页占位 + 路由 + reactive store）
    popup/                   # 小型状态入口
  modules/
    api/client.ts            # 远程 REST 客户端（zod 校验、超时、有限重试）
    storage/index.ts         # chrome.storage.local 类型化封装 + IndexedDB/outbox
    echotik/                 # 适配器（严格按 docs/interface/*.md）、normalize、单位解析
    tiktok/tab-manager.ts    # 单 worker Tab 策略
    miaoshou/adapter.ts      # 妙手按钮适配器（⚠️ 选择器为 PoC 待验证）
    runner/state-machine.ts  # 任务状态机（迁移合法性 + 幂等 key）
    challenge/detector.ts    # 验证/访问限制规则表 + 恢复判据
  shared/
    types/                   # 领域类型、消息协议（type-safe MessageMap）、远程 schema
    messaging.ts             # 类型化 sendMessage / wrapHandler
tests/                       # Vitest 单测
scripts/gen-icons.cjs        # 占位图标生成
```

## 消息协议速览

- UI→background：`client.getState/register/testConnection/updateServerUrl`、`runner.start/pause/resume/cancel/getCheckpoint`、`ranking.startCollect/getProgress`、`widget.openDashboard/locateWorkerTab`
- background→EchoTik 页：`echotik.checkLogin/readPageSelection/fetchApi`
- background→TikTok 页：`tiktok.probe/detectMiaoshou/submitCollect/verifyCollect`
- content→background 事件：`cs.contentReady`、`tiktok.pageReady/challenge/challengeResolved`
- 广播：`runtime.state.push`（Widget/Side Panel 订阅，不持有权威数据）

## 已知待 PoC 项

1. **妙手按钮选择器**（`modules/miaoshou/adapter.ts` `DEFAULT_MIAOSHOU_SELECTORS`）为候选探针，未经真实 Chrome + 妙手官方插件验证；`verifyCollection` 当前恒返回 `UNKNOWN`（无授权 ERP 核对途径，绝不把点击成功当 ERP 成功）
2. EchoTik 登录态检测为页面文案/DOM 组合信号，需真实已登录页面校准
3. TikTok 商品证据探针（`findProductEvidence`）为通用选择器，需真实页面校准
