/**
 * FastMoss 适配器（页面桥接 + 请求模板回放）
 *
 * FastMoss 没有公开的榜单接口文档，且接口路径/参数会随前端版本变化，
 * 因此这里采用「抓取页面自身真实请求 → 回放该请求并改写分页参数」的方式：
 * 1. content script 在页面里挂钩 fetch/XHR，记录榜单相关请求（含完整 URL 模板）；
 * 2. 适配器取最近一次榜单请求作为模板，替换分页/站点/周期参数后重放；
 * 3. 响应结构未知，用结构无关的递归提取找商品数组（见 normalize.ts）。
 *
 * 这样即使 FastMoss 改字段名也能工作；若模板缺失会给出明确的可操作错误。
 */
import {
  ERROR_CODES,
  getPeriodStartDate,
  getPeriodType,
  type ProductRankingEntry,
  type RankingCapabilities,
  type RankingPage,
  type RankingQuery,
  type IRankingAdapter,
} from '@/shared/types';
import { normalizeFastMossItem, extractProductItems } from './normalize';

/** content script 捕获到的一次接口调用 */
export interface CapturedApiCall {
  method: 'GET' | 'POST';
  /** 完整 URL（含 query），用于回放 */
  url: string;
  /** POST 请求体（JSON 字符串） */
  body?: string;
  /** 捕获到的签名请求头（回放时原样带回） */
  headers?: Record<string, string>;
  /** 响应顶层字段名（用于诊断） */
  topKeys?: string[];
  status?: number;
  at: string;
}

/** FastMoss 传输层：经 content script 在页面上下文发同源请求 */
export interface FastMossTransport {
  request(payload: {
    path: string;
    params: Record<string, string | number>;
    method?: 'GET' | 'POST';
    body?: unknown;
    /** 回放时携带的签名头（_time / cnonce / fm-sign 等） */
    headers?: Record<string, string>;
  }): Promise<unknown>;
  /** 读取页面捕获到的接口调用 */
  readCapturedCalls(): Promise<CapturedApiCall[]>;
  /** 读取页面 URL 中的筛选条件 */
  readPageSelection(): Promise<Partial<RankingQuery>>;
}

/** 适配器版本（模板机制变更时递增） */
const ADAPTER_VERSION = 'fastmoss-adapter/0.1.0-template-replay';

/** 单页条数上限（实测 pagesize=20 返回空列表，统一按 10 条/页） */
const MAX_PAGE_SIZE = 10;

/** 可能的“页码”参数名（回放时命中即改写；实测 FastMoss 用 page） */
const PAGE_PARAM_NAMES = ['page', 'pageNum', 'page_no', 'pageNo', 'current', 'currentPage', 'offset', 'start'];
/** 可能的“每页条数”参数名（实测 FastMoss 用 pagesize） */
const PER_PAGE_PARAM_NAMES = ['pagesize', 'per_page', 'perPage', 'pageSize', 'page_size', 'limit', 'size', 'count'];
/** 可能的“站点/国家”参数名 */
const REGION_PARAM_NAMES = ['region', 'country', 'country_code', 'countryCode', 'market', 'area'];
/** 可能的“周期类型”参数名（实测 FastMoss 用 date_type，值 1/2/3 = 日/周/月） */
const PERIOD_TYPE_PARAM_NAMES = ['date_type', 'dateType', 'time_type', 'timeType', 'period', 'date_range', 'dateRange'];
/** 可能的“周期值”参数名（实测 FastMoss 榜单用 date_value；新品榜用 start_date/end_date） */
const PERIOD_VALUE_PARAM_NAMES = ['date_value', 'dateValue', 'date'];
/** 可能的“分类”参数名（实测 FastMoss 用 l1_cid/l2_cid/l3_cid） */
const CATEGORY_PARAM_NAMES = ['l1_cid', 'l2_cid', 'l3_cid', 'category_id', 'categoryId', 'cate_id', 'cateId', 'category'];

/** 周期类型 → FastMoss date_type 枚举（实测：1 日 / 2 周 / 3 月） */
const DATE_TYPE_VALUE: Record<string, number> = { daily: 1, weekly: 2, monthly: 3 };

/** 榜单变体 → 实测接口路径（切换变体时改写模板路径） */
const KNOWN_ENDPOINTS: Record<string, string> = {
  'top-sold': '/api/goods/saleRank',
  'hot-sell': '/api/goods/popRank',
  'news-burst': '/api/goods/newProduct',
};

/** 参数结构相同、可直接互换的两个畅销/热销接口 */
const SALE_RANK_FAMILY = ['/api/goods/saleRank', '/api/goods/popRank'];

/** 榜单变体 → 实测 order 参数（1,2 = 销量降序；4,2 = 热度降序） */
const ORDER_BY_VARIANT: Record<string, string> = {
  'top-sold': '1,2',
  'hot-sell': '4,2',
};

/**
 * 把领域层日期翻译成 FastMoss 榜单接口的 date_value（yyyy-MM-dd）
 * 日榜/周榜都用起始日；月榜用起始月份 yyyy-MM
 * @param query 领域查询
 */
function formatPeriodValue(query: RankingQuery): string | undefined {
  const start = getPeriodStartDate(query);
  if (!start) return undefined;
  const type = getPeriodType(query) ?? 'daily';
  if (type === 'monthly') return start.slice(0, 7);
  return start;
}

/**
 * 计算新品榜需要的 start_date / end_date 区间（FastMoss 新品榜接口按起止日期查询）
 * - 日榜：start=end=起始日
 * - 周榜：end=起始日+6
 * - 月榜：end=当月月末
 * @param query 领域查询
 */
function formatPeriodRange(query: RankingQuery): { start: string; end: string } | undefined {
  const start = getPeriodStartDate(query);
  if (!start) return undefined;
  const startDate = new Date(`${start}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime())) return undefined;
  const fmt = (d: Date): string => d.toISOString().slice(0, 10);
  const type = getPeriodType(query) ?? 'daily';
  const end = new Date(startDate);
  if (type === 'weekly') end.setUTCDate(end.getUTCDate() + 6);
  else if (type === 'monthly') end.setUTCMonth(end.getUTCMonth() + 1, 0);
  return { start: fmt(startDate), end: fmt(end) };
}

/**
 * 判断一次捕获的请求是否像榜单数据请求
 * @param call 捕获记录
 */
export function isRankingCall(call: CapturedApiCall): boolean {
  if (!call?.url) return false;
  // 榜单/商品列表类关键字
  return /rank|ranking|product|goods|list|hot|sale|item/i.test(call.url);
}

/**
 * 在 query 参数集合中按候选名改写参数；返回是否命中
 * @param params 参数集合
 * @param names 候选参数名
 * @param apply 取新值（当前旧值用于判断 offset 之类的语义）
 */
function overrideParam(
  params: URLSearchParams,
  names: string[],
  apply: (oldRaw: string) => string | null,
): boolean {
  for (const name of names) {
    if (!params.has(name)) continue;
    const next = apply(params.get(name) ?? '');
    if (next != null) params.set(name, next);
    return true;
  }
  return false;
}

/**
 * 基于捕获模板构造分页请求地址
 * 页码类型自动识别：offset/start 型按 (page-1)*perPage 计算
 * @param template 捕获到的请求
 * @param page 目标页码（从 1 开始）
 * @param perPage 每页条数
 * @param query 查询条件
 */
export function buildReplayUrl(
  template: CapturedApiCall,
  page: number,
  perPage: number,
  query: RankingQuery,
): { path: string; params: Record<string, string | number> } {
  const url = new URL(template.url, 'https://www.fastmoss.com');
  // 已捕获路径与目标榜单接口的关系：
  // - 同一接口 → 保持
  // - saleRank ↔ popRank（参数结构相同）→ 改写路径
  // - newProduct 等参数结构不同的接口 → 不允许跨接口复用模板，提示重新捕获
  const variant = String(query.rankingVariant ?? '');
  const target = variant ? KNOWN_ENDPOINTS[variant] : undefined;
  const captured = url.pathname;
  if (target && captured !== target && Object.values(KNOWN_ENDPOINTS).includes(captured)) {
    const sameFamily = SALE_RANK_FAMILY.includes(captured) && SALE_RANK_FAMILY.includes(target);
    if (sameFamily) {
      url.pathname = target;
    } else {
      throw Object.assign(
        new Error(`当前捕获的接口与所选榜单不匹配：请打开对应的 FastMoss 页面并切换一次筛选后重试`),
        { code: ERROR_CODES.RANKING_SOURCE_NO_CAPTURE },
      );
    }
  }
  // 分页参数：offset/start 型按 (page-1)*perPage 计算，其余按页码
  for (const name of PAGE_PARAM_NAMES) {
    if (!url.searchParams.has(name)) continue;
    const isOffset = name === 'offset' || name === 'start';
    url.searchParams.set(name, isOffset ? String((page - 1) * perPage) : String(page));
  }
  overrideParam(url.searchParams, PER_PAGE_PARAM_NAMES, () => String(perPage));
  overrideParam(url.searchParams, REGION_PARAM_NAMES, () => query.region);
  // 周期：类型转枚举值（1/2/3），值按日/周/月格式化
  const dateType = DATE_TYPE_VALUE[getPeriodType(query) ?? ''];
  if (dateType != null) overrideParam(url.searchParams, PERIOD_TYPE_PARAM_NAMES, () => String(dateType));
  const periodValue = formatPeriodValue(query);
  if (periodValue) overrideParam(url.searchParams, PERIOD_VALUE_PARAM_NAMES, () => periodValue);
  // 新品榜按起止日期查询（start_date / end_date）
  const range = formatPeriodRange(query);
  if (range) {
    if (url.searchParams.has('start_date')) url.searchParams.set('start_date', range.start);
    if (url.searchParams.has('end_date')) url.searchParams.set('end_date', range.end);
  }
  // 分类：站点约定 l1_cid/l2_cid/l3_cid，l1_cid=all 表示全部分类（等同不筛选）
  if (query.categoryId && query.categoryId !== 'all') {
    // 模板已带分类参数（如从分类列表页捕获的 l1_cid）→ 就地替换；
    // 模板未带分类参数（如榜单页切换分类前的请求）→ 按站点页面约定补 l1_cid
    const replaced = overrideParam(url.searchParams, CATEGORY_PARAM_NAMES, () => query.categoryId!);
    if (!replaced) url.searchParams.set('l1_cid', query.categoryId);
  }
  // 排序：仅对已知变体改写 order（格式如 1,2）
  if (url.searchParams.has('order') && ORDER_BY_VARIANT[variant]) {
    url.searchParams.set('order', ORDER_BY_VARIANT[variant]!);
  }
  const params: Record<string, string | number> = {};
  url.searchParams.forEach((value, key) => {
    params[key] = value;
  });
  return { path: url.pathname + url.search, params: {} };
}

/**
 * 判断响应是否为 FastMoss 风控拦截（实测被拦时返回 code=MSG_SAFE_0001，data 为占位对象）
 * @param payload 接口响应
 */
export function isRiskBlocked(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const code = (payload as Record<string, unknown>).code;
  return typeof code === 'string' && /MSG_SAFE/i.test(code);
}

/**
 * 判断响应是否要求登录（实测深翻页/未登录会返回 MAG_AUTH_xxxx，但仍带部分数据）
 * @param payload 接口响应
 */
export function isAuthRequired(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const code = (payload as Record<string, unknown>).code;
  return typeof code === 'string' && /MAG_AUTH/i.test(code);
}

/** 风控拦截时的重试次数（实测 MSG_SAFE 为间歇性拦截，稍等重试通常可恢复） */
const RISK_RETRY_TIMES = 2;
/** 风控重试间隔区间（毫秒） */
const RISK_RETRY_MIN_MS = 1500;
const RISK_RETRY_MAX_MS = 3000;

/**
 * 随机等待
 * @param min 最小毫秒
 * @param max 最大毫秒
 */
function randomSleep(min: number, max: number): Promise<void> {
  const delay = min + Math.floor(Math.random() * (max - min + 1));
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * 创建 FastMoss 适配器
 * @param transport 页面桥传输层
 */
export function createFastMossAdapter(transport: FastMossTransport): IRankingAdapter {
  /**
   * 选出一个可用的请求模板：优先最近一次带分页参数的榜单请求
   */
  async function pickTemplate(): Promise<CapturedApiCall> {
    const calls = (await transport.readCapturedCalls()).filter(isRankingCall);
    const withPaging = calls.filter((c) => PAGE_PARAM_NAMES.some((n) => c.url.includes(`${n}=`)));
    const template = withPaging[withPaging.length - 1] ?? calls[calls.length - 1];
    if (!template) {
      throw Object.assign(
        new Error('FastMoss 尚未捕获到榜单接口请求：请打开 FastMoss 榜单页并切换一次筛选（国家/周期/分类），再重试'),
        { code: ERROR_CODES.RANKING_SOURCE_NO_CAPTURE },
      );
    }
    return template;
  }

  /**
   * 读取单页数据
   * @param query 查询条件
   * @param page 页码（从 1 开始）
   */
  async function fetchPage(query: RankingQuery, page: number): Promise<RankingPage> {
    const template = await pickTemplate();
    const perPage = Math.min(MAX_PAGE_SIZE, Math.max(1, query.perPage ?? 10));
    const { path } = buildReplayUrl(template, page, perPage, query);
    let payload: unknown;
    // 实测 MSG_SAFE_0001 多为间歇性风控，稍等重试即可恢复（签名本身可跨页复用）
    for (let attempt = 0; ; attempt++) {
      payload = await transport.request({
        path,
        params: {},
        method: template.method,
        body: template.body ? JSON.parse(template.body) : undefined,
        // 带上页面捕获的签名头，避免裸 fetch 被风控拦截
        headers: template.headers,
      });
      if (!isRiskBlocked(payload)) break;
      if (attempt >= RISK_RETRY_TIMES) {
        throw Object.assign(
          new Error('FastMoss 接口被风控拦截：请在榜单页切换一次筛选（重新生成请求签名）后重试'),
          { code: ERROR_CODES.RANKING_SOURCE_UNAUTHORIZED },
        );
      }
      await randomSleep(RISK_RETRY_MIN_MS, RISK_RETRY_MAX_MS);
    }
    // 深翻页/未登录：接口返回 MAG_AUTH_xxxx（仍可能带部分数据），按权限受限处理
    if (isAuthRequired(payload)) {
      throw Object.assign(new Error('FastMoss 提示登录后查看（MAG_AUTH_3004），已停止继续翻页'), {
        code: 'PERMISSION_LIMIT',
      });
    }
    const items = extractProductItems(payload);
    return {
      records: items,
      hasMore: items.length >= perPage,
      page,
      total: undefined,
    };
  }

  return {
    /** 能力声明（FastMoss 目前按商品榜三期/周期维度暴露） */
    async capabilities(): Promise<RankingCapabilities> {
      return {
        variants: ['top-sold', 'hot-sell', 'news-burst', 'products'],
        timeTypes: ['daily', 'weekly', 'monthly'],
        orderFields: { 'top-sold': ['sales', 'gmv'], 'hot-sell': ['sales', 'gmv'] },
        maxPerPage: MAX_PAGE_SIZE,
        adapterVersion: ADAPTER_VERSION,
      };
    },

    /** 读取页面 URL 中的筛选条件（由 content script 解析） */
    async readCurrentPageSelection(): Promise<Partial<RankingQuery>> {
      return transport.readPageSelection().catch(() => ({}));
    },

    /** 单页抓取 */
    fetchRankingPage(query: RankingQuery, _cursor?: string, page = 1): Promise<RankingPage> {
      return fetchPage(query, page);
    },

    /** 归一化单条（region 缺省回填查询站点） */
    normalize(item, query, rankPosition) {
      return normalizeFastMossItem(item, query.region, rankPosition);
    },

    /** 分页聚合：去重、按 limit 截断、支持取消 */
    async fetchAllRankings(query, onProgress, shouldStop) {
      const perPage = Math.min(MAX_PAGE_SIZE, Math.max(1, query.perPage ?? 10));
      const maxPages = Math.max(1, query.maxPages ?? 100);
      const startRank = Math.max(1, query.startRank || 1);
      const startPage = Math.floor((startRank - 1) / perPage) + 1;
      const entries: ProductRankingEntry[] = [];
      const seen = new Set<string>();
      let reason = 'REACHED_LIMIT';
      for (let page = startPage; page < startPage + maxPages; page++) {
        if (shouldStop?.()) {
          reason = 'CANCELLED';
          break;
        }
        let pageResult: RankingPage;
        try {
          pageResult = await fetchPage(query, page);
        } catch (err) {
          const code = (err as { code?: string }).code;
          // 权限受限（MAG_AUTH）保留已抓数据，与 EchoTik 的 PARTIAL 语义一致
          if (code === 'PERMISSION_LIMIT' && entries.length) reason = 'PERMISSION_LIMIT';
          else reason = entries.length ? 'PARTIAL_ERROR' : 'FAILED';
          break;
        }
        if (!pageResult.records.length) {
          reason = 'NO_MORE_DATA';
          break;
        }
        for (const record of pageResult.records) {
          if (entries.length >= query.limit) break;
          const entry = normalizeFastMossItem(record, query.region, entries.length + 1);
          if (seen.has(entry.external_product_id)) continue;
          seen.add(entry.external_product_id);
          entries.push(entry);
        }
        onProgress?.(entries.length, page);
        if (entries.length >= query.limit) {
          reason = 'REACHED_LIMIT';
          break;
        }
        if (!pageResult.hasMore) {
          reason = 'NO_MORE_DATA';
          break;
        }
        // 低频翻页，降低风控概率
        await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 1500)));
      }
      return { entries, reason };
    },

    /** FastMoss 品类树暂未接入，返回空数组（UI 会退化为手填分类） */
    async fetchCategories() {
      return [];
    },
  };
}
