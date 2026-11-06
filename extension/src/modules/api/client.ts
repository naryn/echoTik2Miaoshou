/**
 * 远程 REST API 客户端（规范 §7）
 * - base URL 可配置（默认 http://localhost:8000）
 * - 统一响应 { data, error, request_id }，zod 校验
 * - 鉴权头 X-Client-Id / X-Client-Token（token 只存 chrome.storage.local，由调用方注入）
 * - 超时 + 有限重试（仅网络错误等 retryable 情况）
 */
import type { z } from 'zod';
import {
  ActiveTaskResponseSchema,
  AdminClientListSchema,
  ApiEnvelopeSchema,
  AuthMeSchema,
  AttemptItemSchema,
  BatchDetailSchema,
  BatchItemSchema,
  ClaimTaskResponseSchema,
  ClientMeSchema,
  ProductItemSchema,
  RankHistoryResponseSchema,
  RankingPresetListSchema,
  RankingPresetSchema,
  RegisterResponseSchema,
  SnapshotCreateResponseSchema,
  SnapshotSummarySchema,
  TaskItemSchema,
  paginatedSchema,
  type ActiveTaskResponse,
  type AdminBatchQuery,
  type AdminClientList,
  type AdminProductQuery,
  type AttemptItem,
  type AuthMe,
  type BatchDetail,
  type BatchItem,
  type ClaimTaskResponse,
  type ClientMe,
  type Paginated,
  type ProductItem,
  type RankHistoryResponse,
  type RankingPreset,
  type RegisterResponse,
  type SnapshotCreateResponse,
  type SnapshotSummary,
  type TaskItem,
} from '@/shared/types/remote';
import { ERROR_CODES, getPeriodStartDate, getPeriodType, type ErrorCode, type RankingQuery } from '@/shared/types/domain';

/**
 * 构建 URL query string（跳过 undefined/null/空串）
 * @param params 参数表
 */
export function buildQueryString(
  params: Record<string, string | number | boolean | undefined | null>,
): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

/** API 客户端错误（带稳定错误码与 retryable 分类） */
export class ApiError extends Error {
  constructor(
    public code: ErrorCode | string,
    message: string,
    public retryable = false,
    public httpStatus?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 客户端配置 */
export interface ApiClientOptions {
  /** 惰性获取 base URL（支持设置页动态修改后生效，无需重建客户端） */
  getBaseUrl: () => Promise<string>;
  timeoutMs?: number;
  maxRetries?: number;
  /** 惰性获取鉴权信息（避免在模块加载时读取 storage） */
  getAuth: () => Promise<{ client_id: string | null; client_token: string | null }>;
  /** 插件设置中填写的 auth token（Bearer 认证，所有请求携带） */
  getAuthToken?: () => Promise<string | null>;
}

/** 默认超时与重试参数 */
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;

/**
 * 创建远程 API 客户端
 * @param opts 配置
 */
export function createApiClient(opts: ApiClientOptions) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;

  /**
   * 底层请求：超时控制 + retryable 重试 + envelope 解析
   * @param method HTTP 方法
   * @param path 路径（/v1/...）
   * @param body 请求体
   * @param schema data 字段 zod schema（可选）
   * @param auth 是否携带客户端身份头（旧版 X-Client-Id/X-Client-Token 兼容）
   */
  async function request<T>(
    method: string,
    path: string,
    body: unknown,
    schema: z.ZodType<T> | null,
    auth = true,
  ): Promise<T> {
    let attempt = 0;
    // 仅网络错误/超时/5xx 重试
    for (;;) {
      attempt += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (auth) {
          const { client_id, client_token } = await opts.getAuth();
          if (client_id) headers['X-Client-Id'] = client_id;
          if (client_token) headers['X-Client-Token'] = client_token;
        }
        // 认证 Token（插件设置填写）：服务端优先按 Bearer 解析账号与角色
        const authToken = (await opts.getAuthToken?.()) ?? null;
        if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
        const baseUrl = await opts.getBaseUrl();
        const resp = await fetch(`${baseUrl}${path}`, {
          method,
          headers,
          body: body == null ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        if (resp.status === 401 || resp.status === 403) {
          throw new ApiError(ERROR_CODES.SERVER_UNAUTHORIZED, `远程鉴权失败(${resp.status})`, false, resp.status);
        }
        if (resp.status >= 500) {
          throw new ApiError(ERROR_CODES.SERVER_ERROR, `远程服务错误(${resp.status})`, true, resp.status);
        }
        const json: unknown = await resp.json();
        const env = ApiEnvelopeSchema.safeParse(json);
        if (!env.success) {
          throw new ApiError(ERROR_CODES.SERVER_ERROR, '远程响应格式不符合契约', false, resp.status);
        }
        if (env.data.error) {
          throw new ApiError(env.data.error.code, env.data.error.message, env.data.error.retryable ?? false, resp.status);
        }
        if (!schema) return env.data.data as T;
        const parsed = schema.safeParse(env.data.data);
        if (!parsed.success) {
          throw new ApiError(ERROR_CODES.SERVER_ERROR, `远程 data 校验失败: ${parsed.error.issues[0]?.path.join('.') ?? ''}`, false, resp.status);
        }
        return parsed.data;
      } catch (e) {
        const err =
          e instanceof ApiError
            ? e
            : new ApiError(
                ERROR_CODES.SERVER_UNREACHABLE,
                e instanceof Error ? e.message : String(e),
                true,
              );
        if (err.retryable && attempt <= maxRetries) {
          await sleep(300 * attempt);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  return {
    // ---- 客户端 ----
    /** 注册安装实例，换取 client_id/client_token */
    register(installId: string, displayName: string, extensionVersion: string) {
      return request(
        'POST',
        '/v1/clients/register',
        { install_id: installId, display_name: displayName, extension_version: extensionVersion },
        RegisterResponseSchema,
        false,
      ) as Promise<RegisterResponse>;
    },
    /** 心跳上报 */
    heartbeat(payload: Record<string, unknown>) {
      return request('POST', '/v1/clients/heartbeat', payload, null);
    },
    /** 当前客户端信息 */
    me() {
      return request('GET', '/v1/clients/me', null, ClientMeSchema) as Promise<ClientMe>;
    },
    /** MV3 重启后恢复当前活动任务 */
    activeTask() {
      return request('GET', '/v1/clients/me/active-task', null, ActiveTaskResponseSchema.nullable()) as Promise<ActiveTaskResponse | null>;
    },

    // ---- 账号级榜单筛选预设 ----
    listRankingPresets(source: string) {
      return request('GET', `/v1/ranking-presets?source_platform=${encodeURIComponent(source)}`, null, RankingPresetListSchema) as Promise<{ items: RankingPreset[] }>;
    },
    saveRankingPreset(name: string, source: string, queryJson: Record<string, unknown>) {
      return request('PUT', '/v1/ranking-presets', { name, source_platform: source, query_json: queryJson }, RankingPresetSchema) as Promise<RankingPreset>;
    },
    deleteRankingPreset(presetId: string) {
      return request('DELETE', `/v1/ranking-presets/${encodeURIComponent(presetId)}`, null, null) as Promise<{ deleted: boolean }>;
    },

    // ---- 榜单快照 ----
    /**
     * 创建榜单快照
     * 服务端 SnapshotCreateRequest 要求平铺字段（region/ranking_type 必填），
     * 因此这里把 RankingQuery 的驼峰字段映射为服务端下划线字段。
     * @param payload query 榜单查询条件、filter_json 原始筛选快照、request_id 幂等键
     */
    createSnapshot(payload: {
      query: RankingQuery;
      filter_json: Record<string, unknown>;
      request_id: string;
    }) {
      const { query } = payload;
      // 新管理台将周期统一存放在 query.period；旧版则使用 rankingType/
      // periodStart。写入快照时必须同时兼容两种结构，服务端 ranking_type
      // 为必填字段，不能把 undefined 序列化后交给服务端处理。
      const rankingType = getPeriodType(query);
      if (!rankingType) {
        throw new ApiError(ERROR_CODES.SERVER_ERROR, '采集参数缺少榜单时间类型', false);
      }
      return request(
        'POST',
        '/v1/rank-snapshots',
        {
          request_id: payload.request_id,
          source_platform: query.source ?? 'ECHOTIK',
          region: query.region,
          ranking_type: rankingType,
          ranking_variant: query.rankingVariant ?? null,
          category_id: query.categoryId ?? null,
          period_start: getPeriodStartDate(query) ?? null,
          period_end: query.period?.endDate ?? query.periodEnd ?? null,
          filter_json: payload.filter_json,
        },
        SnapshotCreateResponseSchema,
      ) as Promise<SnapshotCreateResponse>;
    },
    /** 分页批量上传榜单明细（幂等，entries 需符合服务端 EntryItem 结构：sales/gmv 为数值） */
    upsertSnapshotEntries(snapshotId: string, entries: Record<string, unknown>[], requestId: string) {
      return request(
        'POST',
        `/v1/rank-snapshots/${snapshotId}/entries:upsert`,
        { entries, request_id: requestId },
        null,
      );
    },
    /** 标记快照完成/部分完成/失败 */
    finishSnapshot(snapshotId: string, status: 'COMPLETED' | 'PARTIAL' | 'FAILED', totalEntries: number) {
      return request('POST', `/v1/rank-snapshots/${snapshotId}/finish`, {
        status,
        total_entries: totalEntries,
      }, null);
    },
    /** 历史快照查询与筛选 */
    listSnapshots(params: {
      region?: string;
      ranking_type?: string;
      category_id?: string;
      status?: string;
      date_from?: string;
      date_to?: string;
      page?: number;
      per_page?: number;
    }) {
      return request(
        'GET',
        `/v1/rank-snapshots${buildQueryString(params)}`,
        null,
        paginatedSchema(SnapshotSummarySchema),
      ) as Promise<Paginated<SnapshotSummary>>;
    },
    /** 管理员：跨客户端读取全部历史榜单快照（只读）。 */
    adminListSnapshots(params: {
      region?: string;
      ranking_type?: string;
      category_id?: string;
      status?: string;
      source_platform?: string;
      date_from?: string;
      date_to?: string;
      page?: number;
      per_page?: number;
    }) {
      return request(
        'GET',
        `/v1/admin/rank-snapshots${buildQueryString(params)}`,
        null,
        paginatedSchema(SnapshotSummarySchema),
        false,
      ) as Promise<Paginated<SnapshotSummary>>;
    },

    // ---- 商品 ----
    /** 商品列表：服务端分页/筛选/排序 */
    listProducts(params: {
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
    }) {
      return request(
        'GET',
        `/v1/products${buildQueryString(params)}`,
        null,
        paginatedSchema(ProductItemSchema),
      ) as Promise<Paginated<ProductItem>>;
    },
    /** 商品榜单历史 */
    productRankHistory(productId: string) {
      return request(
        'GET',
        `/v1/products/${encodeURIComponent(productId)}/rank-history`,
        null,
        RankHistoryResponseSchema,
      ) as Promise<RankHistoryResponse>;
    },

    // ---- 批次 ----
    /** 创建采集批次 */
    createBatch(payload: {
      snapshot_id?: string;
      product_ids?: string[];
      exclude_already_successful?: boolean;
      interval_seconds: { min: number; max: number };
      idempotency_key: string;
      /** 强制重抓：跳过「已采集去重」（单商品手动测试用） */
      recollect?: boolean;
    }) {
      return request('POST', '/v1/batches', payload, BatchItemSchema) as Promise<BatchItem>;
    },
    /** 批次列表（附聚合进度） */
    listBatches(params: {
      status?: string;
      date_from?: string;
      date_to?: string;
      page?: number;
      per_page?: number;
    }) {
      return request(
        'GET',
        `/v1/batches${buildQueryString(params)}`,
        null,
        paginatedSchema(BatchItemSchema),
      ) as Promise<Paginated<BatchItem>>;
    },
    /** 批次详情与聚合进度 */
    getBatch(batchId: string) {
      return request('GET', `/v1/batches/${batchId}`, null, BatchDetailSchema) as Promise<BatchDetail>;
    },
    /** 批次完整详情（batch_out + summary） */
    getBatchDetail(batchId: string) {
      return request('GET', `/v1/batches/${batchId}`, null, BatchItemSchema) as Promise<BatchItem>;
    },
    /** 批次动作：start/pause/resume/cancel */
    batchAction(batchId: string, action: 'start' | 'pause' | 'resume' | 'cancel', body: Record<string, unknown> = {}) {
      return request('POST', `/v1/batches/${batchId}/${action}`, body, BatchItemSchema) as Promise<BatchItem>;
    },
    /** 失败重抓：创建补采批次（idempotency_key 幂等，默认仅 FAILED） */
    retryFailedBatch(batchId: string, payload: { idempotency_key: string; statuses?: string[]; force?: boolean }) {
      return request('POST', `/v1/batches/${batchId}/retry-failed`, payload, BatchItemSchema) as Promise<BatchItem>;
    },
    /** 批次任务明细（按状态筛选分页） */
    listBatchTasks(batchId: string, params: { status?: string; page?: number; per_page?: number }) {
      return request(
        'GET',
        `/v1/batches/${batchId}/tasks${buildQueryString(params)}`,
        null,
        paginatedSchema(TaskItemSchema),
      ) as Promise<Paginated<TaskItem>>;
    },
    /** 采集尝试日志筛选分页 */
    listAttempts(params: {
      batch_id?: string;
      task_id?: string;
      result?: string;
      error_code?: string;
      date_from?: string;
      date_to?: string;
      page?: number;
      per_page?: number;
    }) {
      return request(
        'GET',
        `/v1/attempts${buildQueryString(params)}`,
        null,
        paginatedSchema(AttemptItemSchema),
      ) as Promise<Paginated<AttemptItem>>;
    },

    // ---- 认证（插件填写 auth token）----
    /** 查询当前 auth token 对应的账号、角色与共享客户端 ID */
    authMe() {
      return request('GET', '/v1/auth/me', null, AuthMeSchema, false) as Promise<AuthMe>;
    },

    // ---- 管理员（auth_users.role=ADMIN，只读）----
    /** 管理员：全量客户端列表（不含 token，用于归属筛选） */
    adminListClients() {
      return request('GET', '/v1/admin/clients', null, AdminClientListSchema, false) as Promise<AdminClientList>;
    },
    /** 管理员：全量采集批次列表（可按客户端/状态/日期筛选） */
    adminListBatches(params: AdminBatchQuery) {
      return request(
        'GET',
        `/v1/admin/batches${buildQueryString(params)}`,
        null,
        paginatedSchema(BatchItemSchema),
        false,
      ) as Promise<Paginated<BatchItem>>;
    },
    /** 管理员：任意客户端批次详情 */
    adminGetBatch(batchId: string) {
      return request(
        'GET',
        `/v1/admin/batches/${encodeURIComponent(batchId)}`,
        null,
        BatchItemSchema,
        false,
      ) as Promise<BatchItem>;
    },
    /** 管理员：任意批次任务明细分页 */
    adminListBatchTasks(
      batchId: string,
      params: { status?: string; page?: number; per_page?: number },
    ) {
      return request(
        'GET',
        `/v1/admin/batches/${encodeURIComponent(batchId)}/tasks${buildQueryString(params)}`,
        null,
        paginatedSchema(TaskItemSchema),
        false,
      ) as Promise<Paginated<TaskItem>>;
    },
    /** 管理员：全量商品筛选分页（支持批次/快照/来源平台） */
    adminListProducts(params: AdminProductQuery) {
      return request(
        'GET',
        `/v1/admin/products${buildQueryString(params)}`,
        null,
        paginatedSchema(ProductItemSchema),
        false,
      ) as Promise<Paginated<ProductItem>>;
    },

    // ---- 任务 ----
    /** 领取下一件任务（带幂等 request_id） */
    claimTask(batchId: string, clientId: string, requestId: string) {
      return request(
        'POST',
        '/v1/tasks/claim',
        { batch_id: batchId, client_id: clientId, request_id: requestId },
        ClaimTaskResponseSchema.nullable(),
      ) as Promise<ClaimTaskResponse | null>;
    },
    /** 单条重新抓取：重置任务为待抓取并跳过去重 */
    recollectTask(taskId: string) {
      return request('POST', `/v1/tasks/${taskId}/recollect`, {}, TaskItemSchema) as Promise<TaskItem>;
    },
    /** 任务心跳/阶段上报 */
    taskHeartbeat(taskId: string, payload: { attempt_id: string; lease_token: string; stage: string }) {
      return request('POST', `/v1/tasks/${taskId}/heartbeat`, payload, null);
    },
    /** 任务事件（幂等 event_id） */
    taskEvent(taskId: string, payload: { event_id: string; event_type: string; payload_json?: Record<string, unknown> }) {
      return request('POST', `/v1/tasks/${taskId}/events`, payload, null);
    },
    /** 任务最终结果（按 attempt_id 幂等） */
    taskResult(
      taskId: string,
      payload: {
        attempt_id: string;
        lease_token: string;
        result: 'SUCCESS' | 'FAILED' | 'UNKNOWN' | 'SKIPPED';
        evidence?: Record<string, unknown>;
        error_code?: string;
        elapsed_ms?: number;
      },
    ) {
      return request('POST', `/v1/tasks/${taskId}/result`, payload, null);
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/**
 * 简单 sleep
 * @param ms 毫秒
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
