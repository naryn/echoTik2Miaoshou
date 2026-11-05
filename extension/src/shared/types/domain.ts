/**
 * 领域合约类型：批次/任务状态、榜单查询、榜单条目、客户端运行时状态
 * 与 MVP 规范 §4/§5/§6 保持一致
 */
import { z } from 'zod';

/** 任务状态（严格按规范 §3.5） */
export const TASK_STATUSES = [
  'PENDING',
  'LEASED',
  'NAVIGATING',
  'PAGE_READY',
  'SUBMITTING',
  'SUBMITTED',
  'SUCCESS',
  'SKIPPED',
  'FAILED',
  'UNKNOWN',
  'WAITING_VERIFICATION',
  'RECOVERING',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TaskStatusSchema = z.enum(TASK_STATUSES);

/** 批次状态（严格按规范 §3.5） */
export const BATCH_STATUSES = [
  'DRAFT',
  'READY',
  'RUNNING',
  'PAUSED',
  'WAITING_VERIFICATION',
  'RECOVERING',
  'COMPLETED',
  'COMPLETED_WITH_ERRORS',
  'CANCELLED',
] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];
export const BatchStatusSchema = z.enum(BATCH_STATUSES);

/** EchoTik 榜单类型（时间粒度），对应接口 time_type */
export const TIME_TYPES = ['daily', 'weekly', 'monthly'] as const;
export type TimeType = (typeof TIME_TYPES)[number];
export const TimeTypeSchema = z.enum(TIME_TYPES);

/** EchoTik 榜单变体（接口路径末段；products 为商品库列表接口，非榜单但同样按排名分页采集） */
export const RANKING_VARIANTS = ['top-sold', 'hot-sell', 'news-burst', 'products'] as const;
export type RankingVariant = (typeof RANKING_VARIANTS)[number];
export const RankingVariantSchema = z.enum(RANKING_VARIANTS);

/** 榜单查询条件（适配器输入，规范 §4.1） */
export interface RankingQuery {
  region: string;
  categoryId?: string;
  rankingType: TimeType | string;
  rankingVariant?: RankingVariant | string;
  /** yyyyMMdd */
  periodStart?: string;
  periodEnd?: string;
  /** 商品库接口统计时间范围（天），仅 rankingVariant=products 使用 */
  dateRange?: number;
  sortBy?: string;
  startRank: number;
  limit: number;
  /** 单页数量（默认 50 上限，请求配置折叠区可调整） */
  perPage?: number;
  /** 页数上限（防止异常分页无限循环） */
  maxPages?: number;
}

/** 原始榜单条目（EchoTik data 数组元素，结构见 docs/interface/*.md） */
export type RawRankingItem = Record<string, unknown>;

/** 榜单分页结果（规范 §4.1） */
export interface RankingPage {
  records: RawRankingItem[];
  hasMore: boolean;
  nextCursor?: string;
  page?: number;
  total?: number;
  sourcePeriod?: { start: string; end: string };
}

/** 榜单能力描述（capabilities() 返回） */
export interface RankingCapabilities {
  variants: RankingVariant[];
  timeTypes: TimeType[];
  orderFields: Record<string, string[]>;
  maxPerPage: number;
  adapterVersion: string;
}

/** EchoTik 类目树节点（product-category 接口 data 元素，递归） */
export interface CategoryNode {
  value: string;
  label: string;
  name_slug?: string;
  children?: CategoryNode[];
}

/** 筛选预设（保存于 chrome.storage.local，供榜单采集页复用） */
export interface FilterPreset {
  name: string;
  query: RankingQuery;
  saved_at: string;
}

/** 执行参数配置（规范 §3.7，本地持久化） */
export interface ExecConfig {
  /** 任务间隔最小秒数 */
  interval_min_sec: number;
  /** 任务间隔最大秒数 */
  interval_max_sec: number;
  /** 单批最多件数 */
  batch_max: number;
  /** 页面等待超时（秒） */
  page_wait_timeout_sec: number;
  /** 妙手按钮检测超时（秒） */
  button_detect_timeout_sec: number;
  /** 提交结果等待（秒） */
  submit_result_wait_sec: number;
  /** 失败最大重试次数（仅暂时性故障；验证码/访问限制不自动重试） */
  max_retries: number;
}

/** 默认执行参数（规范示例：15–30 秒低频） */
export const DEFAULT_EXEC_CONFIG: ExecConfig = {
  interval_min_sec: 15,
  interval_max_sec: 30,
  batch_max: 200,
  page_wait_timeout_sec: 30,
  button_detect_timeout_sec: 15,
  submit_result_wait_sec: 20,
  max_retries: 2,
};

/** 行为配置（规范 §3.7） */
export interface BehaviorConfig {
  /** 关闭 Side Panel 后继续任务 */
  continue_on_panel_close: boolean;
  /** 异常系统通知开关 */
  notify_on_exception: boolean;
  /** 日志保留天数 */
  log_retention_days: number;
}

/** 默认行为配置 */
export const DEFAULT_BEHAVIOR_CONFIG: BehaviorConfig = {
  continue_on_panel_close: true,
  notify_on_exception: true,
  log_retention_days: 7,
};

/** 解析后的数量（"万"/"亿" 单位已折算为数值，同时保留原文） */
export interface ParsedQuantity {
  value: number | null;
  raw: string;
  currency?: 'USD' | 'CNY';
}

/** 归一化后的榜单商品条目（上传远程 rank_entries 的基础结构） */
export interface ProductRankingEntry {
  external_product_id: string;
  region: string;
  title: string;
  shop?: { id?: string; name?: string };
  rank_position: number;
  sales?: ParsedQuantity;
  gmv?: ParsedQuantity;
  image_url?: string;
  category?: string;
  detail_url?: string;
  metrics?: Record<string, unknown>;
  observed_at: string;
}

/** EchoTik 适配器合约（规范 §4.1） */
export interface IEchoTikAdapter {
  capabilities(): Promise<RankingCapabilities>;
  readCurrentPageSelection(tabId: number): Promise<Partial<RankingQuery>>;
  fetchRankingPage(query: RankingQuery, cursor?: string, page?: number): Promise<RankingPage>;
  normalize(item: RawRankingItem, query: RankingQuery, rankPosition: number): ProductRankingEntry;
}

/** 妙手适配器合约（规范 §5.2），实现见 modules/miaoshou/adapter.ts */
export interface IMiaoshouAdapter {
  detectAvailability(): Promise<{ available: boolean; evidence: string; reason?: string }>;
  findCollectAction(): Promise<{ supported: boolean; reason?: string }>;
  submitCollectAction(): Promise<{ submitted: boolean; evidence?: string; errorCode?: string }>;
  verifyCollection(
    productId: string,
  ): Promise<{ state: 'CONFIRMED' | 'NOT_CONFIRMED' | 'UNKNOWN'; evidence?: string }>;
}

/** 任务运行检查点（持久化到 chrome.storage.local） */
export interface RunnerCheckpoint {
  active_batch_id: string | null;
  active_task_id: string | null;
  attempt_id: string | null;
  lease_token: string | null;
  runner_stage: TaskStatus | 'IDLE' | null;
  worker_tab_id: number | null;
  /** 当前任务商品信息快照（恢复时核对用） */
  product?: {
    external_product_id: string;
    region: string;
    detail_url?: string | null;
  } | null;
  /** 下一任务计划执行时间（ISO），由任务间隔产生 */
  next_run_at?: string | null;
  /** 是否处于用户暂停 */
  paused: boolean;
  /** 最近一次页面探测的证据（诊断用，如命中验证规则/结构信息） */
  last_probe_evidence?: string;
  updated_at: string;
}

/** 客户端身份与连接状态 */
export interface ClientIdentity {
  install_id: string | null;
  client_id: string | null;
  client_token: string | null;
  server_url: string;
  registered_at: string | null;
}

/** 对 UI/浮动 Widget 广播的运行时状态 */
export interface RuntimePublicState {
  connected: boolean;
  registered: boolean;
  client_id: string | null;
  active_batch_id: string | null;
  runner_stage: RunnerCheckpoint['runner_stage'];
  paused: boolean;
  waiting_verification: boolean;
  progress: { done: number; total: number } | null;
  current_product_title?: string | null;
  last_error?: string | null;
}

/** 统一错误码（扩展内部使用） */
export const ERROR_CODES = {
  ECHOTIK_UNAUTHORIZED: 'ECHOTIK_UNAUTHORIZED',
  /** 会员套餐/访客权限限制：接口返回会员升级页而非数据（登录态本身可能正常） */
  ECHOTIK_PERMISSION_LIMIT: 'ECHOTIK_PERMISSION_LIMIT',
  ECHOTIK_BAD_RESPONSE: 'ECHOTIK_BAD_RESPONSE',
  ECHOTIK_NETWORK: 'ECHOTIK_NETWORK',
  SERVER_UNREACHABLE: 'SERVER_UNREACHABLE',
  SERVER_UNAUTHORIZED: 'SERVER_UNAUTHORIZED',
  SERVER_ERROR: 'SERVER_ERROR',
  NOT_REGISTERED: 'NOT_REGISTERED',
  TIKTOK_CHALLENGE: 'TIKTOK_CHALLENGE',
  TIKTOK_ACCESS_RESTRICTED: 'TIKTOK_ACCESS_RESTRICTED',
  TIKTOK_PRODUCT_MISMATCH: 'TIKTOK_PRODUCT_MISMATCH',
  /** 商品在当前国家/地区不可用（页面提示“此国家或地区未提供…”） */
  PRODUCT_REGION_UNAVAILABLE: 'PRODUCT_REGION_UNAVAILABLE',
  MIAOSHOU_UNAVAILABLE: 'MIAOSHOU_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
