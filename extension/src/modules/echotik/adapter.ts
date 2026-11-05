/**
 * EchoTik 适配器：严格按 docs/interface/*.md 实现 IEchoTikAdapter
 * - top-sold / hot-sell / news-burst 三榜单：time_type(daily/weekly/monthly)、time_range(yyyyMMdd)、page/per_page、product_categories、order
 * - products 商品库接口、product-category 类目树接口
 * - 分页终止：达 limit / 接口无下一页 / 连续重复页或空页
 * - 401/403/登录失效抛 typed error
 *
 * 传输层通过注入的 EchoTikTransport 实现（background 中接到 content script 桥），
 * 本模块不直接依赖 chrome.* API，便于单测。
 */
import { z } from 'zod';
import {
  ERROR_CODES,
  type CategoryNode,
  type IEchoTikAdapter,
  type ProductRankingEntry,
  type RankingCapabilities,
  type RankingPage,
  type RankingQuery,
  type RankingVariant,
} from '@/shared/types/domain';
import { normalizeRankingItem } from './normalize';

/** EchoTik 接口 envelope */
const EchoTikEnvelopeSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z.unknown().optional(),
  meta: z
    .object({
      current_page: z.number(),
      last_page: z.number(),
      per_page: z.number().optional(),
      total: z.number().optional(),
    })
    .optional(),
});

/** 已确认的成功业务码：接口当前返回 100004（msg=ok 且有 data），文档示例为 0，两者都兼容 */
const SUCCESS_CODES = new Set([0, 100004]);

/** 业务成功码判定（类目树等接口复用） */
function isSuccessCode(code: number): boolean {
  return SUCCESS_CODES.has(code);
}

/**
 * 接口单页数量上限：免费/访客套餐只允许 per_page<=10，
 * 超过会返回 HTTP 200 的会员限制 HTML 页（"member plan is Visitor..."），
 * 表现为 JSON 解析失败。付费套餐可放宽，这里按最保守值取。
 */
const MAX_PAGE_SIZE = 10;
/** 翻页之间的随机等待区间（毫秒），降低连续请求被风控/限流的概率 */
const PAGE_INTERVAL_MIN_MS = 2000;
const PAGE_INTERVAL_MAX_MS = 5000;

/**
 * 翻页随机等待：在最小/最大区间内随机取一个时长
 * @param shouldStop 外部取消检查（取消时提前结束等待）
 */
async function waitBeforeNextPage(shouldStop?: () => boolean): Promise<void> {
  const delay = PAGE_INTERVAL_MIN_MS + Math.floor(Math.random() * (PAGE_INTERVAL_MAX_MS - PAGE_INTERVAL_MIN_MS + 1));
  const step = 200;
  let elapsed = 0;
  while (elapsed < delay) {
    if (shouldStop?.()) return;
    const chunk = Math.min(step, delay - elapsed);
    await new Promise((resolve) => setTimeout(resolve, chunk));
    elapsed += chunk;
  }
}

/** 类目树节点（定义已上移至 shared/types/domain，此处再导出保持兼容） */
export type { CategoryNode } from '@/shared/types/domain';

/** EchoTik 传输层：在页面上下文发同源 fetch 的最小能力 */
export interface EchoTikTransport {
  /**
   * 请求白名单内的 EchoTik 接口
   * @param path 接口路径（/api/v1/...）
   * @param params query 参数
   * @param lang 语言（默认 zh-CN，en 用于补全英文类目对照）
   */
  request(path: string, params: Record<string, string | number>, lang?: 'zh-CN' | 'en'): Promise<unknown>;
}

/** EchoTik 业务错误 */
export class EchoTikError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus?: number,
  ) {
    super(message);
    this.name = 'EchoTikError';
  }
}

/** 各榜单变体已证实的排序字段（来自 interface/*.md 示例） */
const ORDER_FIELDS: Record<RankingVariant, string[]> = {
  'top-sold': ['sale_cnt', 'total_gmv_amt'],
  'hot-sell': ['sale_cnt', 'total_gmv_amt'],
  'news-burst': ['total_sale_gmv_7d_amt'],
  // 商品库接口（products.md）：order 只使用文档示例中出现的字段
  products: [
    'total_sale_nd_cnt',
    'total_sale_gmv_nd_amt',
    'total_sale_7d_cnt',
    'total_sale_30d_cnt',
    'total_sale_cnt',
    'total_sale_gmv_amt',
    'view_count',
    'influencers_count',
    'videos_count',
  ],
};

/** 商品库变体标识（走 /api/v1/data/products，无 time_type/time_range） */
const PRODUCTS_VARIANT = 'products';

const ADAPTER_VERSION = 'echotik-adapter/1.0.0';

/**
 * 创建 EchoTik 适配器
 * @param transport 页面同源请求传输层
 */
export function createEchoTikAdapter(transport: EchoTikTransport): IEchoTikAdapter & {
  fetchAllRankings(
    query: RankingQuery,
    onProgress?: (fetched: number, page: number) => void,
    shouldStop?: () => boolean,
  ): Promise<{ entries: ProductRankingEntry[]; reason: string; total?: number }>;
  fetchCategories(lang?: 'zh-CN' | 'en'): Promise<CategoryNode[]>;
} {
  /**
   * 按变体选择接口路径：商品库走 /api/v1/data/products，其余走 leaderboard/{variant}
   * @param variant 榜单变体
   */
  function variantPath(variant: string): string {
    return variant === PRODUCTS_VARIANT
      ? '/api/v1/data/products'
      : `/api/v1/data/products/leaderboard/${variant}`;
  }

  /**
   * 调用榜单/商品库接口并解析 envelope + meta
   * @param variant 榜单变体
   * @param params query 参数
   */
  async function callLeaderboard(
    variant: string,
    params: Record<string, string | number>,
  ): Promise<{ data: Record<string, unknown>[]; meta: { current_page: number; last_page: number; total?: number } }> {
    const raw = await transport.request(variantPath(variant), params);
    return parseEnvelope(raw);
  }

  /**
   * 解析 EchoTik envelope，处理鉴权失败与格式错误
   * @param raw 原始响应
   */
  function parseEnvelope(raw: unknown): {
    data: Record<string, unknown>[];
    meta: { current_page: number; last_page: number; total?: number };
  } {
    const env = EchoTikEnvelopeSchema.safeParse(raw);
    if (!env.success) {
      throw new EchoTikError(ERROR_CODES.ECHOTIK_BAD_RESPONSE, 'EchoTik 响应格式不符合契约');
    }
    if (env.data.code === 401 || env.data.code === 403) {
      throw new EchoTikError(ERROR_CODES.ECHOTIK_UNAUTHORIZED, `EchoTik 登录失效/未授权(code=${env.data.code})`);
    }
    // 成功判定：命中已知成功码，或响应确实带了 data 数组（接口新版本改用 100004）
    const isSuccess = isSuccessCode(env.data.code) || Array.isArray(env.data.data);
    if (!isSuccess) {
      throw new EchoTikError(ERROR_CODES.ECHOTIK_BAD_RESPONSE, `EchoTik 返回错误: ${env.data.msg ?? env.data.code}`);
    }
    const meta = env.data.meta
      ? { current_page: env.data.meta.current_page, last_page: env.data.meta.last_page, total: env.data.meta.total }
      : { current_page: 1, last_page: 1, total: undefined };
    return { data: Array.isArray(env.data.data) ? (env.data.data as Record<string, unknown>[]) : [], meta };
  }

  /**
   * 将 RankingQuery 映射为接口 query 参数（严格按文档字段名）
   * - 榜单三接口：time_type / time_range / page / per_page / product_categories / order
   * - 商品库接口：page / per_page / dateRange / product_categories / order / sort（无 time_type/time_range）
   * @param query 查询条件
   * @param page 页码
   * @param perPage 每页数量
   */
  function toParams(query: RankingQuery, page: number, perPage: number): Record<string, string | number> {
    const variant = (query.rankingVariant as string) ?? 'top-sold';
    if (variant === PRODUCTS_VARIANT) {
      const params: Record<string, string | number> = {
        page,
        per_page: perPage,
        dateRange: query.dateRange ?? 7,
        product_categories: query.categoryId ?? '',
        sort: 'desc',
      };
      if (query.sortBy) params.order = query.sortBy;
      return params;
    }
    const params: Record<string, string | number> = {
      time_type: String(query.rankingType).toLowerCase(),
      time_range: query.periodStart ?? '',
      page,
      per_page: perPage,
      product_categories: query.categoryId ?? '',
    };
    if (query.sortBy) params.order = query.sortBy;
    return params;
  }

  return {
    /**
     * 返回适配器能力（依据 interface/*.md 已证实的能力，未证实项不宣称）
     */
    async capabilities(): Promise<RankingCapabilities> {
      return {
        variants: ['top-sold', 'hot-sell', 'news-burst', 'products'],
        timeTypes: ['daily', 'weekly', 'monthly'],
        orderFields: ORDER_FIELDS,
        maxPerPage: MAX_PAGE_SIZE,
        adapterVersion: ADAPTER_VERSION,
      };
    },

    /**
     * 读取当前 EchoTik 页面筛选条件（由 background 通过 content script 实现，此处为占位）
     * @param _tabId 目标 Tab
     */
    async readCurrentPageSelection(_tabId: number): Promise<Partial<RankingQuery>> {
      // 实际实现位于 background：向 echotik content script 发 'echotik.readPageSelection'
      return {};
    },

    /**
     * 抓取单页榜单数据
     * @param query 查询条件
     * @param _cursor 游标（EchoTik 使用页码分页，未使用）
     * @param page 页码（默认 1）
     */
    async fetchRankingPage(query: RankingQuery, _cursor?: string, page = 1): Promise<RankingPage> {
      const variant = (query.rankingVariant as string) ?? 'top-sold';
      const perPage = Math.min(MAX_PAGE_SIZE, Math.max(1, query.perPage ?? query.limit ?? MAX_PAGE_SIZE));
      const { data, meta } = await callLeaderboard(variant, toParams(query, page, perPage));
      return {
        records: data,
        hasMore: meta.current_page < meta.last_page,
        page: meta.current_page,
        total: meta.total,
      };
    },

    /**
     * 归一化单条原始记录
     * @param item 原始条目
     * @param query 查询条件
     * @param rankPosition 排名（1 起）
     */
    normalize(item, query, rankPosition): ProductRankingEntry {
      return normalizeRankingItem(item, query, rankPosition);
    },

    /**
     * 分页抓取榜单直到终止条件（达 limit / 无下一页 / 连续重复页或空页）
     * @param query 查询条件
     * @param onProgress 进度回调
     * @param shouldStop 外部取消检查
     */
    async fetchAllRankings(query, onProgress, shouldStop) {
      const variant = (query.rankingVariant as string) ?? 'top-sold';
      const perPage = Math.min(MAX_PAGE_SIZE, Math.max(1, query.perPage ?? query.limit));
      const maxPages = Math.max(1, query.maxPages ?? 100);
      const startRank = Math.max(1, query.startRank || 1);
      const startPage = Math.floor((startRank - 1) / perPage) + 1;
      const entries: ProductRankingEntry[] = [];
      const seen = new Set<string>();
      let page = startPage;
      let total: number | undefined;
      let reason = 'REACHED_LIMIT';

      for (;;) {
        if (shouldStop?.()) {
          reason = 'CANCELLED';
          break;
        }
        if (page - startPage >= maxPages) {
          reason = 'MAX_PAGES';
          break;
        }
        let pageResult: {
          data: Record<string, unknown>[];
          meta: { current_page: number; last_page: number; total?: number };
        };
        try {
          pageResult = await callLeaderboard(variant, toParams(query, page, perPage));
        } catch (e) {
          // 会员/访客套餐翻页到上限后，接口会返回会员限制页（非 JSON）。
          // 已有数据时按正常结束处理，保留已抓部分；首页即受限才抛出明确错误。
          const code = (e as { code?: string }).code;
          if (
            entries.length > 0 &&
            (code === ERROR_CODES.ECHOTIK_PERMISSION_LIMIT || code === ERROR_CODES.ECHOTIK_UNAUTHORIZED)
          ) {
            reason = 'PERMISSION_LIMIT';
            break;
          }
          throw e;
        }
        const { data, meta } = pageResult;
        total = meta.total;
        if (data.length === 0) {
          reason = 'EMPTY_PAGE';
          break;
        }
        let newOnThisPage = 0;
        for (let i = 0; i < data.length; i++) {
          const rank = (page - 1) * perPage + i + 1;
          if (rank < startRank) continue;
          try {
            const entry = normalizeRankingItem(data[i]!, query, rank);
            if (seen.has(entry.external_product_id)) continue;
            seen.add(entry.external_product_id);
            newOnThisPage += 1;
            entries.push(entry);
          } catch {
            // 商品 ID 缺失/非法的条目归入异常，不进入队列（规范 §4.3）
          }
          if (entries.length >= query.limit) break;
        }
        onProgress?.(entries.length, page);
        if (entries.length >= query.limit) break;
        if (newOnThisPage === 0) {
          reason = 'DUPLICATE_PAGE';
          break;
        }
        if (meta.current_page >= meta.last_page) {
          reason = 'NO_MORE_PAGES';
          break;
        }
        page += 1;
        // 翻页限速：随机等待 2–5 秒后再请求下一页
        await waitBeforeNextPage(shouldStop);
      }
      return { entries, reason, total };
    },

    /**
     * 获取商品类目树（无分页，一次返回）
     */
    async fetchCategories(lang?: 'zh-CN' | 'en'): Promise<CategoryNode[]> {
      const raw = await transport.request('/api/v1/data/products/product-category', {}, lang);
      const env = EchoTikEnvelopeSchema.safeParse(raw);
      if (!env.success || !isSuccessCode(env.data.code) || !Array.isArray(env.data.data)) {
        throw new EchoTikError(ERROR_CODES.ECHOTIK_BAD_RESPONSE, '类目树响应格式不符合契约');
      }
      return env.data.data as CategoryNode[];
    },
  };
}
