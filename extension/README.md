# TK 采集助手（Chrome MV3 扩展）

EchoTik 榜单采集 → TikTok 商品页 → 妙手 ERP「采集此商品」联动的浏览器端扩展。
技术栈：WXT + TypeScript + Vue 3（独立管理台页面/Popup）+ zod + Vitest，Manifest V3（minimum_chrome_version 120）。

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
3. 点击工具栏图标打开 Popup，再点「打开管理台」以独立窗口打开管理页面
4. 管理台首次使用需填写「认证 Token」完成授权，未授权时插件不可用

## 远程 API 配置

- 默认 base URL：`http://localhost:8000`（可在管理台 → 设置 页修改并测试连接，保存于 `chrome.storage.local.server_url`）
- 统一响应 `{ data, error, request_id }`；账号级认证头 `Authorization: Bearer <auth_token>`
- 同一 Token 在任意浏览器解析为同一个账号：普通用户仅能读取自己的数据，`role=ADMIN` 可读取全量数据
- 商品等业务数据只读服务端，不做本地存储（仅保留运行必需的 outbox/断点）
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
    manager/                 # Vue 3 管理台（独立页面窗口：六页 + 路由 + reactive store）
    popup/                   # 小型状态入口
  modules/
    api/client.ts            # 远程 REST 客户端（zod 校验、超时、有限重试）
    storage/index.ts         # chrome.storage.local 类型化封装 + IndexedDB/outbox
    echotik/                 # 适配器（严格按 docs/interface/*.md）、normalize、单位解析
    tiktok/tab-manager.ts    # 单 worker Tab 策略
    miaoshou/adapter.ts      # 妙手按钮适配器（真实页面已验证）
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

## TikTok / 妙手联动说明

- 商品详情页优先使用服务端返回 URL；TikTok 跳转为 `/us/pdp/.../{productId}` 等实际 PDP 地址时，Content Script 会从 URL 识别商品 ID 并继续执行，不会把跳转后的地址误判为非商品页。
- 已在真实 TikTok 页面验证妙手入口位于普通 DOM：`.earth-wxt-collect-panel-button-group` 内的 `<earth-wxt-button>`，适配器会解析嵌套自定义元素并只派发一次点击序列，避免同一商品重复进入妙手公用采集箱。
- 点击已触发的含义是“已向妙手插件提交采集操作”；无授权的 ERP 回执/采集箱查询能力时，任务结果仍保持 `UNKNOWN`，不把 DOM 点击成功等同于 ERP 最终成功。
- 排障时可在管理台的设置/调试日志查看 `cs.contentReady`、`tiktok.pageReady`、`detectMiaoshou`、`submitCollect` 等事件；请同时保留 TikTok 工作页，避免在任务执行中手动关闭或跳转该标签页。

## 仍需持续验证

1. EchoTik 登录态检测为页面文案/DOM 组合信号，需随站点改版校准。
2. TikTok 页面结构、妙手插件版本及 ERP 最终回执可能变化；出现失败时先导出调试日志，再更新适配器规则。
