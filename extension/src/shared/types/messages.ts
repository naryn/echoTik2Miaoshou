/**
 * 扩展内部消息协议（type-safe message map）
 * 约定：所有 chrome.runtime.sendMessage 消息均为 { type, payload } 信封，
 * 响应为 { ok: true, data } 或 { ok: false, error: { code, message } }。
 */
import type {
  RankingQuery,
  RankingPage,
  RuntimePublicState,
  RunnerCheckpoint,
  CategoryNode,
  ProductRankingEntry,
} from './domain';
import type {
  AttemptItem,
  BatchItem,
  ClientMe,
  Paginated,
  ProductItem,
  RankHistoryResponse,
  SnapshotSummary,
  TaskItem,
} from './remote';

/** 消息信封 */
export interface MessageEnvelope<K extends keyof MessageMap> {
  type: K;
  payload: MessageMap[K]['req'];
}

/** 统一响应包装 */
export type MessageResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

/** 消息映射表：req 为请求 payload，res 为成功时 data 内容 */
export interface MessageMap {
  // ---- 通用 ----
  ping: { req: void; res: { pong: true; ts: string } };

  // ---- UI → background ----
  'client.getState': { req: void; res: RuntimePublicState };
  'client.register': { req: { server_url?: string } | void; res: { client_id: string } };
  'client.testConnection': { req: void; res: { connected: boolean; latency_ms: number } };
  'client.updateServerUrl': { req: { server_url: string }; res: { saved: true } };
  'runner.start': { req: { batchId: string }; res: { started: true } };
  'runner.pause': { req: void; res: { paused: true } };
  'runner.resume': { req: void; res: { resumed: true } };
  'runner.cancel': { req: void; res: { cancelled: true } };
  'runner.getCheckpoint': { req: void; res: RunnerCheckpoint };
  'ranking.startCollect': { req: { query: RankingQuery }; res: { snapshot_local_id: string } };
  'ranking.getProgress': {
    req: void;
    res: {
      running: boolean;
      fetched: number;
      limit: number;
      page: number;
      done: boolean;
      reason?: string;
    };
  };
  'widget.openDashboard': { req: void; res: { opened: true } };
  'widget.locateWorkerTab': { req: void; res: { focused: boolean } };

  // ---- 数据查询类（UI → background → 远程 REST 薄透传，规范 §7） ----
  /** 历史榜单快照筛选分页 */
  'snapshot.list': {
    req: {
      region?: string;
      ranking_type?: string;
      category_id?: string;
      status?: string;
      date_from?: string;
      date_to?: string;
      page?: number;
      per_page?: number;
    };
    res: Paginated<SnapshotSummary>;
  };
  /** 读取当前 EchoTik 页面筛选并启动采集（复用 ranking.startCollect 流程） */
  'snapshot.createFromCurrent': {
    req: { overrides?: Partial<RankingQuery> } | void;
    res: { started: true };
  };
  /** 取消进行中的榜单分页抓取（已抓数据保留并标 PARTIAL） */
  'ranking.cancelCollect': { req: void; res: { cancelled: true } };
  /** 预览榜单首页（仅抓取不归一化入库，不写远程快照） */
  'ranking.preview': {
    req: { query: RankingQuery };
    res: { items: ProductRankingEntry[]; total?: number; hasMore: boolean };
  };
  /** EchoTik 类目树（background 抓取 + chrome.storage.local 缓存） */
  'echotik.getCategories': {
    req: { force?: boolean } | void;
    res: { items: CategoryNode[]; cached: boolean; fetched_at: string };
  };
  /** 商品服务端分页/筛选/排序 */
  'product.list': {
    req: {
      keyword?: string;
      region?: string;
      category?: string;
      ranking_type?: string;
      snapshot_date_from?: string;
      snapshot_date_to?: string;
      rank_min?: number;
      rank_max?: number;
      erp_status?: string;
      sort?: string;
      order?: 'asc' | 'desc';
      page?: number;
      per_page?: number;
    };
    res: Paginated<ProductItem>;
  };
  /** 商品榜单历史 */
  'product.rankHistory': { req: { product_id: string }; res: RankHistoryResponse };
  /** 本地采集商品分页/筛选/排序（数据源为 IndexedDB，不访问远端列表） */
  'product.listLocal': {
    req: {
      keyword?: string;
      region?: string;
      category?: string;
      ranking_variant?: string;
      date_from?: string;
      date_to?: string;
      rank_min?: number;
      rank_max?: number;
      /** 按批次过滤：只保留该批次任务包含的商品 */
      batch_id?: string;
      sort?: string;
      order?: 'asc' | 'desc';
      page?: number;
      per_page?: number;
    };
    res: Paginated<ProductItem>;
  };
  /** 单件商品直接采集（商品列表页测试 ERP 采集用：建单商品批次并立即启动） */
  'product.collectSingle': {
    req: { external_product_id: string; region: string };
    res: { batch_id: string };
  };
  /** 批次列表（附聚合进度） */
  'batch.list': {
    req: { status?: string; date_from?: string; date_to?: string; page?: number; per_page?: number };
    res: Paginated<BatchItem>;
  };
  /** 批次详情（含聚合进度） */
  'batch.get': { req: { batch_id: string }; res: BatchItem };
  /** 创建采集批次（idempotency_key 由前端生成 UUID 传入） */
  'batch.create': {
    req: {
      snapshot_id?: string;
      product_ids?: string[];
      exclude_already_successful?: boolean;
      interval_seconds?: { min: number; max: number };
      idempotency_key: string;
    };
    res: BatchItem;
  };
  /** 批次控制（按 §8.2 状态机语义，服务端校验） */
  'batch.start': { req: { batch_id: string }; res: BatchItem };
  'batch.recollectTask': { req: { task_id: string }; res: TaskItem };
  'batch.pause': { req: { batch_id: string }; res: BatchItem };
  'batch.resume': { req: { batch_id: string }; res: BatchItem };
  'batch.cancel': { req: { batch_id: string }; res: BatchItem };
  /** 失败重抓：创建补采批次（idempotency_key 由前端生成） */
  'batch.retryFailed': {
    req: { batch_id: string; idempotency_key: string; statuses?: string[]; force?: boolean };
    res: BatchItem;
  };
  /** 批次任务明细（状态筛选分页） */
  'batch.tasks': {
    req: { batch_id: string; status?: string; page?: number; per_page?: number };
    res: Paginated<TaskItem>;
  };
  /** 采集尝试日志筛选分页 */
  'attempt.list': {
    req: {
      batch_id?: string;
      task_id?: string;
      result?: string;
      error_code?: string;
      date_from?: string;
      date_to?: string;
      page?: number;
      per_page?: number;
    };
    res: Paginated<AttemptItem>;
  };
  /** 当前客户端信息（远程 /v1/clients/me） */
  'client.me': { req: void; res: ClientMe };
  /** 手动触发 outbox 补传（返回本次成功补传条数） */
  'outbox.flush': { req: void; res: { synced: number; remaining: number } };
  /** 页面环境探测：EchoTik 登录态 / TikTok 工作 Tab / 妙手检测 / 服务器连通 */
  'env.check': {
    req: void;
    res: {
      echotik: { tab_found: boolean; logged_in: boolean | null; evidence: string };
      tiktok: { worker_tab_found: boolean; tab_id: number | null };
      miaoshou: { checked: boolean; available: boolean | null; evidence: string };
      server: { connected: boolean; latency_ms: number | null };
    };
  };

  // ---- background → EchoTik content script ----
  'echotik.checkLogin': {
    req: void;
    res: { loggedIn: boolean; evidence: string };
  };
  'echotik.readPageSelection': { req: void; res: Partial<RankingQuery> };
  'echotik.fetchApi': {
    req: { path: string; params: Record<string, string | number>; lang?: 'zh-CN' | 'en' };
    res: unknown;
  };

  // ---- background → TikTok content script ----
  'tiktok.probe': {
    req: { expectedProductId: string };
    res: {
      state: 'READY' | 'CHALLENGE' | 'ACCESS_RESTRICTED' | 'MISMATCH' | 'LOADING' | 'REGION_UNAVAILABLE';
      productId?: string;
      reason?: string;
      evidence?: string;
    };
  };
  'tiktok.detectMiaoshou': {
    req: void;
    res: { available: boolean; evidence: string; reason?: string };
  };
  'tiktok.submitCollect': {
    req: void;
    res: { submitted: boolean; evidence?: string; errorCode?: string };
  };
  'tiktok.verifyCollect': {
    req: { productId: string };
    res: { state: 'CONFIRMED' | 'NOT_CONFIRMED' | 'UNKNOWN'; evidence?: string };
  };

  // ---- content script → background 事件 ----
  'cs.contentReady': {
    req: { site: 'echotik' | 'tiktok'; url: string };
    res: { ack: true };
  };
  'tiktok.pageReady': {
    req: { productId: string; url: string };
    res: { ack: true };
  };
  'tiktok.challenge': {
    req: { kind: 'CHALLENGE' | 'ACCESS_RESTRICTED'; evidence: string; url: string };
    res: { ack: true };
  };
  'tiktok.challengeResolved': { req: { url: string }; res: { ack: true } };
  'tiktok.regionUnavailable': {
    req: { evidence: string; url: string; productId?: string };
    res: { ack: true };
  };

  // ---- background → 所有订阅方广播（widget/sidepanel 只读） ----
  'runtime.state.push': { req: RuntimePublicState; res: void };
}

/** 允许 content script 发起的 EchoTik 接口路径白名单前缀（MAIN world 桥共用） */
export const ECHOTIK_ALLOWED_PATHS = [
  '/api/v1/data/products/leaderboard/top-sold',
  '/api/v1/data/products/leaderboard/hot-sell',
  '/api/v1/data/products/leaderboard/news-burst',
  '/api/v1/data/products/product-category',
  '/api/v1/data/products',
] as const;

/**
 * 校验接口路径是否在白名单内（防任意 URL 请求）
 * @param path 待校验路径
 */
export function isAllowedEchoTikPath(path: string): boolean {
  return ECHOTIK_ALLOWED_PATHS.some(
    (p) => path === p || (path.startsWith('/api/v1/data/products') && path === p),
  );
}

/** MAIN world 桥消息协议常量（固定协议 + nonce） */
export const PAGE_BRIDGE = {
  /** ISOLATED → MAIN 请求类型 */
  REQUEST: 'ECHOTIK_EXT_BRIDGE_REQUEST',
  /** MAIN → ISOLATED 响应类型 */
  RESPONSE: 'ECHOTIK_EXT_BRIDGE_RESPONSE',
} as const;

/** MAIN world 桥请求体 */
export interface PageBridgeRequest {
  type: typeof PAGE_BRIDGE.REQUEST;
  nonce: string;
  path: string;
  params: Record<string, string | number>;
  /** 响应语言：默认 zh-CN；en 仅用于拉取英文类目名做中文对照 */
  lang?: 'zh-CN' | 'en';
}

/** MAIN world 桥响应体 */
export interface PageBridgeResponse {
  type: typeof PAGE_BRIDGE.RESPONSE;
  nonce: string;
  ok: boolean;
  status?: number;
  data?: unknown;
  error?: string;
}
