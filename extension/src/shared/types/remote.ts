/**
 * 远程 REST API 合约类型与 zod schema（规范 §7）
 * 统一响应 { data, error, request_id }；鉴权头 X-Client-Id / X-Client-Token
 */
import { z } from 'zod';
import { BatchStatusSchema, TaskStatusSchema } from './domain';

/** 统一响应 envelope schema（data 由调用方再按端点解析） */
export const ApiEnvelopeSchema = z.object({
  data: z.unknown().nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean().optional(),
    })
    .nullable(),
  request_id: z.string().optional(),
});
export type ApiEnvelope = z.infer<typeof ApiEnvelopeSchema>;

/** 客户端注册响应 */
export const RegisterResponseSchema = z.object({
  client_id: z.string(),
  client_token: z.string(),
  display_name: z.string().optional(),
  registered_at: z.string().optional(),
});
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;

/** 任务领取响应中的商品信息 */
export const ClaimedProductSchema = z.object({
  external_product_id: z.string(),
  region: z.string(),
  detail_url: z.string().nullable().optional(),
  title: z.string().optional(),
});
export type ClaimedProduct = z.infer<typeof ClaimedProductSchema>;

/** 任务领取响应 */
export const ClaimTaskResponseSchema = z.object({
  task_id: z.string(),
  attempt_id: z.string(),
  lease_token: z.string(),
  lease_expires_at: z.string().optional(),
  product: ClaimedProductSchema,
});
export type ClaimTaskResponse = z.infer<typeof ClaimTaskResponseSchema>;

/** 服务端 active-task 恢复响应（无活动任务时 data 为 null） */
export const ActiveTaskResponseSchema = z.object({
  batch_id: z.string(),
  task_id: z.string(),
  attempt_id: z.string().optional(),
  lease_token: z.string().optional(),
  status: TaskStatusSchema,
  product: ClaimedProductSchema.optional(),
});
export type ActiveTaskResponse = z.infer<typeof ActiveTaskResponseSchema>;

/** 批次详情响应（聚合进度） */
export const BatchDetailSchema = z.object({
  batch_id: z.string(),
  status: BatchStatusSchema,
  total: z.number().optional(),
  summary: z
    .object({
      success: z.number().optional(),
      failed: z.number().optional(),
      skipped: z.number().optional(),
      unknown: z.number().optional(),
      pending: z.number().optional(),
      /** 服务端 batch_summary 的原始状态聚合（如 SUCCESS / FAILED） */
      by_status: z.record(z.number()).optional(),
      terminal: z.number().optional(),
    })
    .partial()
    .optional(),
});
export type BatchDetail = z.infer<typeof BatchDetailSchema>;

/** 榜单快照创建响应 */
export const SnapshotCreateResponseSchema = z.object({
  snapshot_id: z.string(),
});
export type SnapshotCreateResponse = z.infer<typeof SnapshotCreateResponseSchema>;

/** 批次创建响应 */
export const BatchCreateResponseSchema = z.object({
  batch_id: z.string(),
  total: z.number().optional(),
});
export type BatchCreateResponse = z.infer<typeof BatchCreateResponseSchema>;

// ---------------- 查询类端点（列表/详情，与服务端 schemas.*_out 对齐） ----------------

/** 通用分页结构 schema 生成器
 * @param item 单条记录 schema
 */
export function paginatedSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number(),
    page: z.number(),
    per_page: z.number(),
  });
}

/** 通用分页结构 */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  per_page: number;
}

/** 榜单快照摘要（服务端 snapshot_out） */
export const SnapshotSummarySchema = z.object({
  snapshot_id: z.string(),
  client_id: z.string().optional(),
  /** 榜单数据来源平台（ECHOTIK / FASTMOSS），历史快照可能为空（视为 ECHOTIK） */
  source_platform: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  ranking_type: z.string().nullable().optional(),
  ranking_variant: z.string().nullable().optional(),
  category_id: z.string().nullable().optional(),
  period_start: z.string().nullable().optional(),
  period_end: z.string().nullable().optional(),
  capture_started_at: z.string().nullable().optional(),
  capture_finished_at: z.string().nullable().optional(),
  status: z.string(),
  filter_json: z.record(z.unknown()).nullable().optional(),
  total_entries: z.number().nullable().optional(),
  request_id: z.string().optional(),
});
export type SnapshotSummary = z.infer<typeof SnapshotSummarySchema>;

/** 商品列表项（服务端 product_out + erp_status） */
export const ProductItemSchema = z.object({
  id: z.string(),
  platform: z.string().optional(),
  region: z.string().nullable().optional(),
  external_product_id: z.string(),
  title: z.string().nullable().optional(),
  shop_id: z.string().nullable().optional(),
  shop_name: z.string().nullable().optional(),
  image_url: z.string().nullable().optional(),
  detail_url: z.string().nullable().optional(),
  first_seen_at: z.string().nullable().optional(),
  last_seen_at: z.string().nullable().optional(),
  raw_excerpt: z.record(z.unknown()).nullable().optional(),
  /** 榜单来源平台（ECHOTIK / FASTMOSS） */
  source_platform: z.string().nullable().optional(),
  erp_status: z.string().nullable().optional(),
});
export type ProductItem = z.infer<typeof ProductItemSchema>;

/** 已收集图片元数据（服务端 collected_images） */
export const CollectedImageSchema = z.object({
  image_id: z.string(),
  client_id: z.string(),
  product_id: z.string().nullable().optional(),
  source_url: z.string().nullable().optional(),
  mime_type: z.string(),
  file_size: z.number(),
  sha256: z.string(),
  title: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  source_platform: z.string().nullable().optional(),
  status: z.string(),
  created_at: z.string().nullable().optional(),
  /** 同一客户端此前已上传过相同文件 */
  deduped: z.boolean(),
});
export type CollectedImage = z.infer<typeof CollectedImageSchema>;

/** 榜单明细项（服务端 rank_entry_out，可携带快照） */
export const RankEntrySchema = z.object({
  id: z.string(),
  snapshot_id: z.string(),
  product_id: z.string(),
  rank_position: z.number().nullable().optional(),
  sales: z.unknown().nullable().optional(),
  gmv: z.unknown().nullable().optional(),
  metrics_json: z.record(z.unknown()).nullable().optional(),
  observed_at: z.string().nullable().optional(),
  snapshot: SnapshotSummarySchema.optional(),
});
export type RankEntry = z.infer<typeof RankEntrySchema>;

/** 商品榜单历史响应 */
export const RankHistoryResponseSchema = z.object({
  product: ProductItemSchema,
  items: z.array(RankEntrySchema),
});
export type RankHistoryResponse = z.infer<typeof RankHistoryResponseSchema>;

/** 批次聚合进度（服务端 batch_summary） */
export const BatchSummarySchema = z
  .object({
    success: z.number().optional(),
    failed: z.number().optional(),
    skipped: z.number().optional(),
    unknown: z.number().optional(),
    pending: z.number().optional(),
    total: z.number().optional(),
    /** 服务端 batch_summary 的原始状态聚合（如 SUCCESS / FAILED） */
    by_status: z.record(z.number()).optional(),
    terminal: z.number().optional(),
  })
  .partial();
export type BatchSummary = z.infer<typeof BatchSummarySchema>;

/** 批次列表/详情项（服务端 batch_out，含聚合进度） */
export const BatchItemSchema = z.object({
  batch_id: z.string(),
  client_id: z.string().optional(),
  /** 来源榜单平台（ECHOTIK / FASTMOSS） */
  source_platform: z.string().nullable().optional(),
  source_snapshot_id: z.string().nullable().optional(),
  parent_batch_id: z.string().nullable().optional(),
  status: BatchStatusSchema,
  created_at: z.string().nullable().optional(),
  started_at: z.string().nullable().optional(),
  finished_at: z.string().nullable().optional(),
  config_json: z.record(z.unknown()).nullable().optional(),
  summary_json: z.record(z.unknown()).nullable().optional(),
  idempotency_key: z.string().optional(),
  summary: BatchSummarySchema.optional(),
  /** 来源榜单快照信息（服务端 batch_out 附带） */
  snapshot: z
    .object({
      snapshot_id: z.string().optional(),
      source_platform: z.string().nullable().optional(),
      region: z.string().nullable().optional(),
      ranking_type: z.string().nullable().optional(),
      ranking_variant: z.string().nullable().optional(),
      category_id: z.string().nullable().optional(),
      period_start: z.string().nullable().optional(),
      period_end: z.string().nullable().optional(),
      total_entries: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
  /** 创建响应附加字段：服务端返回布尔值（是否新建，幂等重放为 false） */
  created: z.boolean().optional(),
  /** 幂等重放时服务端返回 null */
  skipped_already_successful: z.number().nullable().optional(),
});
export type BatchItem = z.infer<typeof BatchItemSchema>;

/** 批次任务项（服务端 task_out，可携带商品） */
export const TaskItemSchema = z.object({
  task_id: z.string(),
  batch_id: z.string(),
  product_id: z.string(),
  status: TaskStatusSchema,
  attempt_count: z.number().nullable().optional(),
  claimed_by_client_id: z.string().nullable().optional(),
  lease_expires_at: z.string().nullable().optional(),
  last_error_code: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  product: ProductItemSchema.nullable().optional(),
});
export type TaskItem = z.infer<typeof TaskItemSchema>;

/** 采集尝试记录（服务端 attempt_out；不得包含 Cookie/Token） */
export const AttemptItemSchema = z.object({
  attempt_id: z.string(),
  task_id: z.string(),
  client_id: z.string().optional(),
  started_at: z.string().nullable().optional(),
  finished_at: z.string().nullable().optional(),
  stage: z.string().nullable().optional(),
  result: z.string().nullable().optional(),
  evidence_json: z.record(z.unknown()).nullable().optional(),
  error_code: z.string().nullable().optional(),
  elapsed_ms: z.number().nullable().optional(),
});
export type AttemptItem = z.infer<typeof AttemptItemSchema>;

/** 当前客户端信息（服务端 client_out，不含 token） */
export const ClientMeSchema = z.object({
  client_id: z.string(),
  display_name: z.string().nullable().optional(),
  install_id: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  registered_at: z.string().nullable().optional(),
  last_seen_at: z.string().nullable().optional(),
  extension_version: z.string().nullable().optional(),
});
export type ClientMe = z.infer<typeof ClientMeSchema>;

/** 认证身份（服务端 /v1/auth/me 与 /v1/auth/login） */
export const AuthMeSchema = z.object({
  client_id: z.string(),
  display_name: z.string().nullable().optional(),
  role: z.enum(['USER', 'ADMIN']).or(z.string()),
  registered_at: z.string().nullable().optional(),
  extension_version: z.string().nullable().optional(),
  last_seen_at: z.string().nullable().optional(),
  /** 设备会话凭证（单设备登录） */
  session_id: z.string().nullable().optional(),
});
export type AuthMe = z.infer<typeof AuthMeSchema>;

/** 服务端账号级榜单筛选预设。 */
export const RankingPresetSchema = z.object({
  preset_id: z.string(),
  name: z.string(),
  source_platform: z.enum(['ECHOTIK', 'FASTMOSS']).or(z.string()),
  query_json: z.record(z.unknown()),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
});
export type RankingPreset = z.infer<typeof RankingPresetSchema>;
export const RankingPresetListSchema = z.object({ items: z.array(RankingPresetSchema) });

/** 管理员：全量客户端列表响应 */
export const AdminClientListSchema = z.object({
  items: z.array(ClientMeSchema),
});
export type AdminClientList = z.infer<typeof AdminClientListSchema>;

/** 管理员：全量商品列表查询参数（服务端 /v1/admin/products） */
export interface AdminProductQuery {
  [key: string]: string | number | undefined;
  keyword?: string;
  region?: string;
  category?: string;
  ranking_type?: string;
  ranking_variant?: string;
  source_platform?: string;
  snapshot_id?: string;
  batch_id?: string;
  snapshot_date_from?: string;
  snapshot_date_to?: string;
  rank_min?: number;
  rank_max?: number;
  erp_status?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  page?: number;
  per_page?: number;
}

/** 管理员：全量批次列表查询参数（服务端 /v1/admin/batches） */
export interface AdminBatchQuery {
  [key: string]: string | number | undefined;
  client_id?: string;
  status?: string;
  date_from?: string;
  date_to?: string;
  page?: number;
  per_page?: number;
}
