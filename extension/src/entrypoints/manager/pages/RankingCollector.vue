<script setup lang="ts">
/**
 * 榜单采集页 RankingCollector（规范 §3.3，MVP 主入口）
 * - 配置驱动筛选表单：站点（待验证标注）/三级级联类目/榜单变体×日周月/日期周期/排序维度（仅已证实值）/
 *   排名范围/采集数量（默认 100，单页 20 / 默认最多 5 页）/去重策略/请求配置折叠区
 * - 按钮：读取当前页面筛选条件 / 预览榜单（不持久化）/ 获取并保存榜单（分页进度+取消 PARTIAL）/ 保存筛选预设
 * - 历史榜单子区：筛选 + 快照行 + 查看商品/重新获取同条件/从快照创建 ERP 批次
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { sendMsg } from '@/shared/messaging';
import { computePeriodStartDate } from '@/shared/types';
import type {
  CategoryNode,
  ProductRankingEntry,
  RankingQuery,
  RankingSource,
  SnapshotSummary,
} from '@/shared/types';
import type { RankingPreset } from '@/shared/types/remote';
import { classifyError, formatTime, statusBadgeClass, statusText, uuid } from '../utils';

const router = useRouter();

// ---------------- 表单状态（配置驱动，能力来自 docs/adapters/echotik-mapping.md） ----------------

/** 站点选项：接口无站点参数（待验证），以 EchoTik 页面会话为准；默认墨西哥 */
const REGION_OPTIONS = [
  { value: 'ALL', label: '全球' },
  { value: 'US', label: '美国' },
  { value: 'MX', label: '墨西哥' },
  { value: 'BR', label: '巴西' },
  { value: 'VN', label: '越南' },
  { value: 'TH', label: '泰国' },
  { value: 'PH', label: '菲律宾' },
  { value: 'MY', label: '马来西亚' },
  { value: 'ID', label: '印尼' },
  { value: 'SG', label: '新加坡' },
  { value: 'JP', label: '日本' },
  { value: 'UK', label: '英国' },
  { value: 'ES', label: '西班牙' },
  { value: 'DE', label: '德国' },
  { value: 'IT', label: '意大利' },
  { value: 'FR', label: '法国' },
  { value: 'GR', label: '希腊' },
  { value: 'BE', label: '比利时' },
  { value: 'CZ', label: '捷克' },
  { value: 'PL', label: '波兰' },
  { value: 'PT', label: '葡萄牙' },
  { value: 'AT', label: '奥地利' },
  { value: 'HU', label: '匈牙利' },
  { value: 'NL', label: '荷兰' },
  { value: 'IE', label: '爱尔兰' },
] as const;

/** 榜单变体（已证实三接口路径 + 商品库列表接口） */
const VARIANT_OPTIONS = [
  { value: 'top-sold', label: '热销榜' },
  { value: 'hot-sell', label: '热推榜' },
  { value: 'news-burst', label: '新品榜' },
  { value: 'video-rank', label: '带货视频榜' },
  { value: 'products', label: '商品库' },
] as const;

/** 商品库统计范围（products.md 的 dateRange，天） */
const DATE_RANGE_OPTIONS = [
  { value: 7, label: '近 7 天' },
  { value: 30, label: '近 30 天' },
] as const;

/** 榜单类型（已证实 time_type） */
const TIME_TYPE_OPTIONS = [
  { value: 'daily', label: '日榜' },
  { value: 'weekly', label: '周榜' },
  { value: 'monthly', label: '月榜' },
] as const;

/** 已证实排序字段（映射文档 §6 + products.md，其余隐藏） */
const ORDER_FIELD_LABELS: Record<string, string> = {
  sale_cnt: '销量',
  total_gmv_amt: 'GMV',
  total_sale_gmv_7d_amt: '7 日 GMV 增长',
  total_sale_nd_cnt: '近 N 天销量',
  total_sale_gmv_nd_amt: '近 N 天 GMV',
  total_sale_7d_cnt: '近 7 天销量',
  total_sale_30d_cnt: '近 30 天销量',
  total_sale_cnt: '总销量',
  view_count: '播放量',
  influencers_count: '关联达人数',
  videos_count: '关联视频数',
};
const ORDER_FIELDS_BY_VARIANT: Record<string, string[]> = {
  'top-sold': ['sale_cnt', 'total_gmv_amt'],
  'hot-sell': ['sale_cnt', 'total_gmv_amt'],
  'news-burst': ['total_sale_gmv_7d_amt'],
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

/** 筛选表单结构（每个来源平台各持一份，参数不共享） */
interface FilterForm {
  source: RankingSource;
  region: string;
  sellerType: '' | 'cross-border' | 'local';
  cat1: string;
  cat2: string;
  cat3: string;
  variant: string;
  timeType: string;
  dateRange: number;
  date: string;
  week: string;
  month: string;
  sortBy: string;
  startRank: number;
  endRank: number;
  dedup: 'ALL' | 'EXCLUDE_SUCCESS';
  /** 单页数量 */
  perPage: number;
  /** 页数上限 */
  maxPages: number;
}

/** 按浏览器本地日历计算昨日，避免 UTC 零点附近把默认榜单日期错置到当天。 */
function yesterdayDate(): string {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * 创建指定来源平台的表单默认值
 * - 采集数量统一默认 100 条（endRank=100）
 * - EchoTik：单页 20、默认最多 5 页；FastMoss：单页 10、默认最多 10 页
 * @param source 来源平台
 * @param perPage 默认单页数量
 * @param maxPages 默认页数上限
 */
function createFilterForm(source: RankingSource, perPage: number, maxPages: number): FilterForm {
  return {
    source,
    region: 'MX',
    sellerType: '',
    cat1: '',
    cat2: '',
    cat3: '',
    variant: 'top-sold',
    timeType: 'daily',
    dateRange: 7,
    date: yesterdayDate(), // yyyy-MM-dd；日榜默认取已完整结算的昨日数据
    week: '', // yyyy-Www
    month: '', // yyyy-MM
    sortBy: '',
    startRank: 1,
    endRank: 100,
    dedup: 'ALL',
    perPage,
    maxPages,
  };
}

/** 各来源平台独立表单：切换 Tab 时保留各自参数（FastMoss 与 EchoTik 参数体系不同） */
const forms = reactive<Record<RankingSource, FilterForm>>({
  ECHOTIK: createFilterForm('ECHOTIK', 20, 5),
  FASTMOSS: createFilterForm('FASTMOSS', 10, 10),
});

/** 当前选中的来源 Tab */
const activeSource = ref<RankingSource>('ECHOTIK');

/** 当前 Tab 对应的表单（读写都会落到该平台自己的状态） */
const form = computed<FilterForm>(() => forms[activeSource.value]);

/** 各来源平台的单页数量可选项（EchoTik 默认 20；FastMoss 实测仅 10） */
const PAGE_SIZE_BY_SOURCE: Record<RankingSource, number[]> = {
  ECHOTIK: [20, 50, 10],
  FASTMOSS: [10],
};

/** 当前来源平台的单页数量可选项 */
const pageSizeOptions = computed(() => PAGE_SIZE_BY_SOURCE[form.value.source] ?? [20]);

/** 来源平台注册表（用于 Tab 与打开页面提示，来自 background） */
interface SourceOption {
  id: RankingSource;
  label: string;
  origin: string;
  boardUrl: string;
  available: boolean;
  unavailableReason?: string;
}
const sources = ref<SourceOption[]>([]);

/** 来源 Tab 列表（注册表加载前回退内置两项，保证 Tab 始终可见） */
const sourceTabs = computed<SourceOption[]>(() =>
  sources.value.length
    ? sources.value
    : [
        { id: 'ECHOTIK', label: 'EchoTik', origin: 'https://echotik.live', boardUrl: 'https://echotik.live/board', available: true },
        {
          id: 'FASTMOSS',
          label: 'FastMoss',
          origin: 'https://www.fastmoss.com',
          boardUrl: 'https://www.fastmoss.com/e-commerce/saleslist',
          available: true,
        },
      ],
);

/** 当前来源平台的元信息（用于展示打开页面提示） */
const currentSourceMeta = computed(() => sourceTabs.value.find((s) => s.id === form.value.source));

/** 各来源平台支持的榜单变体（FastMoss：畅销/热销/新品榜单 + 商品库搜索列表） */
const VARIANT_BY_SOURCE: Record<RankingSource, string[]> = {
  ECHOTIK: ['top-sold', 'hot-sell', 'news-burst', 'products'],
  FASTMOSS: ['top-sold', 'hot-sell', 'news-burst', 'video-rank'],
};

/** 当前平台可用的榜单变体选项 */
const variantOptions = computed(() =>
  VARIANT_OPTIONS.filter((v) => (VARIANT_BY_SOURCE[form.value.source] ?? []).includes(v.value)),
);

/** FastMoss 榜单变体的界面名称（site 叫法：saleslist=销量榜、hotlist=热推榜） */
const FAST_MOSS_VARIANT_LABELS: Record<string, string> = {
  'top-sold': '销量榜',
  'hot-sell': '热推榜',
  'news-burst': '新品榜',
  'video-rank': '带货视频榜',
};

/**
 * 按来源平台取榜单变体展示名
 * @param value 变体标识
 * @param source 来源平台（缺省用当前表单平台）
 */
function variantLabel(value?: string | null, source?: string | null): string {
  if (!value) return '—';
  const id = source ?? form.value.source;
  if (id === 'FASTMOSS') return FAST_MOSS_VARIANT_LABELS[value] ?? value;
  return VARIANT_OPTIONS.find((v) => v.value === value)?.label ?? value;
}

/** 类目树（background 抓取 + 缓存） */
const categories = ref<CategoryNode[]>([]);
const catLoading = ref(false);
const catError = ref<string | null>(null);

/** 级联类目选项 */
const cat1Options = computed(() => categories.value);
const cat2Options = computed(() => cat1Options.value.find((c) => c.value === form.value.cat1)?.children ?? []);
const cat3Options = computed(() => cat2Options.value.find((c) => c.value === form.value.cat2)?.children ?? []);

/** 当前变体可用的排序维度（仅已证实值；FastMoss 排序参数待验证，暂不展示） */
const sortOptions = computed(() =>
  form.value.source === 'FASTMOSS' ? [] : (ORDER_FIELDS_BY_VARIANT[form.value.variant] ?? []),
);
const isDateFreeFastMossVariant = computed(() => form.value.source === 'FASTMOSS' && form.value.variant === 'video-rank');

/**
 * 切换来源 Tab：各平台表单与分类缓存互相独立，切回时保留原配置。
 * @param id 目标来源平台
 */
function switchSource(id: RankingSource): void {
  activeSource.value = id;
  void loadCategories();
  void loadPresets();
  // 国家/站点没有面板内的可编辑值；切换来源时立即以该来源页顶部设置覆盖旧显示。
  void syncPageSelection(id, true).catch(() => undefined);
}

/**
 * 加载来源平台列表（background 注册表）
 */
async function loadSources(): Promise<void> {
  try {
    const r = await sendMsg('ranking.sources', undefined);
    sources.value = r.items;
  } catch (e) {
    errorText.value = classifyError(e).text;
  }
}

/**
 * 来源平台展示名（历史数据缺省视为 EchoTik）
 * @param p 平台标识
 */
function sourceLabel(p?: string | null): string {
  const id = p ?? 'ECHOTIK';
  return sources.value.find((s) => s.id === id)?.label ?? (id === 'FASTMOSS' ? 'FastMoss' : 'EchoTik');
}

/** 采集数量（由排名范围推导） */
const limit = computed(() => Math.max(1, form.value.endRank - form.value.startRank + 1));

/** 结束原因文案 */
const REASON_TEXT: Record<string, string> = {
  REACHED_LIMIT: '达到采集数量',
  NO_MORE_PAGES: '接口无更多页',
  NO_MORE_DATA: '接口无更多数据',
  PARTIAL_ERROR: '部分页请求失败（已保存已抓部分）',
  EMPTY_PAGE: '返回空页',
  DUPLICATE_PAGE: '连续重复页',
  CANCELLED: '用户取消（已保存部分标 PARTIAL）',
  PERMISSION_LIMIT: '会员/访客权限限制，已保存已抓部分（PARTIAL）',
  MAX_PAGES: '达到页数上限',
  UPLOAD_PARTIAL: '部分上传失败（标 PARTIAL）',
  REFRESHING_FASTMOSS: '正在刷新 FastMoss 榜单页并检查验证状态',
  WAITING_VERIFICATION: 'FastMoss 出现滑块/人机验证；请在 FastMoss 页面完成验证后重新获取',
};

// ---------------- 运行/预览/预设状态 ----------------

/** 预览结果 */
const preview = ref<{ items: ProductRankingEntry[]; total?: number; hasMore: boolean } | null>(null);
const previewing = ref(false);
/** 桥接自检：逐个榜单请求首页 1 条，验证 MAIN 桥与登录态（不写快照） */
interface SelfTestItem {
  variant: string;
  label: string;
  ok: boolean;
  count: number;
  message: string;
  ms: number;
}
const selfTesting = ref(false);
const selfTestResults = ref<SelfTestItem[]>([]);
/** 采集进度（轮询 ranking.getProgress） */
const progress = ref<{ running: boolean; fetched: number; limit: number; page: number; done: boolean; reason?: string } | null>(null);
/** 操作反馈/错误 */
const feedback = ref<string | null>(null);
const errorText = ref<string | null>(null);
/** 预设 */
const presets = ref<RankingPreset[]>([]);
const presetName = ref('');
const selectedPresetIds = ref<string[]>([]);
const presetBatchRunning = ref(false);
const presetBatchStatus = ref({ running: false, current: 0, total: 0, completed: 0, failed: 0 });
const presetsLoading = ref(false);
const presetsExpanded = ref(false);
const allPresetsSelected = computed(
  () => presets.value.length > 0 && presets.value.every((preset) => selectedPresetIds.value.includes(preset.preset_id)),
);
/** 历史快照 */
const snapshots = ref<SnapshotSummary[]>([]);
const snapshotTotal = ref(0);
const snapFilter = ref({ status: '', source_platform: '', date_from: '', date_to: '' });
const snapLoading = ref(false);
/** 各来源的高级请求配置默认收起，避免常用筛选被低频参数淹没。 */
const requestConfigExpanded = ref(false);

/**
 * 将表单转换为 RankingQuery
 * - 榜单三接口：日期按日/周/月切换为 time_range=yyyyMMdd
 * - 商品库接口：无 time_range，改用 dateRange（7/30 天），rankingType 固定 products
 */
function buildQuery(): RankingQuery {
  const f = form.value;
  const categoryId = f.cat3 || f.cat2 || f.cat1 || undefined;
  // 覆盖采集数量所需的最少页数（不额外 +1，保持默认 100 条 / 每页 20 条 = 5 页）
  const perPageSafe = Math.max(1, f.perPage);
  const firstPage = Math.floor((f.startRank - 1) / perPageSafe) + 1;
  const lastPage = Math.ceil((f.startRank - 1 + limit.value) / perPageSafe);
  const maxPages = Math.max(f.maxPages, lastPage - firstPage + 1);
  if (f.variant === 'products') {
    return {
      source: f.source,
      region: f.region,
      categoryId,
      rankingVariant: f.variant,
      period: { type: 'products', periodDays: f.dateRange },
      sortBy: f.sortBy || undefined,
      startRank: f.startRank,
      limit: limit.value,
      perPage: f.perPage,
      maxPages,
    };
  }
  const startDate = computePeriodStartDate(f.timeType, f.date, f.week, f.month);
  return {
    source: f.source,
    region: f.region,
    categoryId,
    sellerType: f.sellerType || undefined,
    rankingVariant: f.variant,
    period: { type: f.timeType, startDate },
    sortBy: f.sortBy || undefined,
    startRank: f.startRank,
    limit: limit.value,
    perPage: f.perPage,
    maxPages,
  };
}

/**
 * 加载类目树（经 background，带缓存）
 * @param force 强制刷新缓存
 */
async function loadCategories(force = false): Promise<void> {
  catLoading.value = true;
  catError.value = null;
  try {
    const r = await sendMsg('ranking.getCategories', { source: form.value.source, force });
    categories.value = r.items;
  } catch (e) {
    catError.value = classifyError(e).text;
  } finally {
    catLoading.value = false;
  }
}

/**
 * 读取当前榜单页面的筛选条件（按来源平台分流到对应 content script）
 */
async function syncPageSelection(source: RankingSource, silent = false): Promise<void> {
  if (!silent) {
    feedback.value = null;
    errorText.value = null;
  }
  try {
    const sel = await sendMsg('ranking.readPageSelection', { source });
    // 仅应用页面真实读到的字段，不做猜测填充
    // 只允许页面顶部国家选择器提供站点；面板默认值、预设和 URL 参数都不能覆盖它。
    if (!sel.region) throw new Error('未能从当前页面顶部国家/站点选择器读取站点，请先在来源页面选择国家后重试');
    const target = forms[source];
    target.region = sel.region;
    if (sel.rankingType) target.timeType = String(sel.rankingType).toLowerCase();
    if (sel.rankingVariant) target.variant = String(sel.rankingVariant);
    if (sel.categoryId) target.cat1 = sel.categoryId;
    if (sel.periodStart && /^\d{8}$/.test(sel.periodStart)) {
      const p = sel.periodStart;
      target.date = `${p.slice(0, 4)}-${p.slice(4, 6)}-${p.slice(6, 8)}`;
    }
    if (sel.sortBy) target.sortBy = sel.sortBy;
    if (!silent) feedback.value = `已同步 ${source === 'FASTMOSS' ? 'FastMoss' : 'EchoTik'} 页面顶部国家/站点及可读取筛选条件。`;
  } catch (e) {
    if (!silent) errorText.value = classifyError(e).text;
    throw e;
  }
}

/** 手动同步入口；自动同步失败不会干扰页面其它功能。 */
async function readPageSelection(): Promise<void> {
  await syncPageSelection(form.value.source).catch(() => undefined);
}

/**
 * 预览榜单：抓首页展示，不持久化
 */
async function doPreview(): Promise<void> {
  previewing.value = true;
  preview.value = null;
  errorText.value = null;
  try {
    await syncPageSelection(form.value.source, true);
    preview.value = await sendMsg('ranking.preview', { query: buildQuery() });
  } catch (e) {
    errorText.value = classifyError(e).text;
  } finally {
    previewing.value = false;
  }
}

/**
 * 构造自检查询：站点/日期沿用表单，固定只取首页 1 条，避免触发接口频控
 * @param variant 榜单变体
 */
function buildSelfTestQuery(variant: string): RankingQuery {
  const f = form.value;
  const categoryId = f.cat3 || f.cat2 || f.cat1 || undefined;
  if (variant === 'products') {
    return {
      source: f.source,
      region: f.region,
      categoryId,
      rankingVariant: variant,
      period: { type: 'products', periodDays: f.dateRange || 7 },
      startRank: 1,
      limit: 1,
      perPage: 1,
    };
  }
  const startDate = computePeriodStartDate(f.timeType, f.date, f.week, f.month);
  return {
    source: f.source,
    region: f.region,
    categoryId,
    sellerType: f.sellerType || undefined,
    rankingVariant: variant,
    period: { type: f.timeType, startDate },
    startRank: 1,
    limit: 1,
    perPage: 1,
  };
}

/**
 * 桥接自检：依次经 background → content script MAIN 桥请求 4 个榜单首页
 * 只统计成功/失败与条数，不创建快照、不写本地数据
 */
async function runSelfTest(): Promise<void> {
  if (selfTesting.value) return;
  selfTesting.value = true;
  selfTestResults.value = [];
  errorText.value = null;
  try {
    for (const v of variantOptions.value) {
      const t0 = Date.now();
      try {
        const r = await sendMsg('ranking.preview', { query: buildSelfTestQuery(v.value) });
        selfTestResults.value = [
          ...selfTestResults.value,
          { variant: v.value, label: v.label, ok: true, count: r.items.length, message: `JSON 正常，返回 ${r.items.length} 条`, ms: Date.now() - t0 },
        ];
      } catch (e) {
        selfTestResults.value = [
          ...selfTestResults.value,
          { variant: v.value, label: v.label, ok: false, count: 0, message: classifyError(e).text, ms: Date.now() - t0 },
        ];
      }
    }
  } finally {
    selfTesting.value = false;
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let presetBatchTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 获取并保存榜单：启动后台采集并轮询进度；结束后停止轮询
 */
async function startCollect(): Promise<void> {
  errorText.value = null;
  feedback.value = null;
  try {
    await syncPageSelection(form.value.source, true);
    await sendMsg('ranking.startCollect', { query: buildQuery() });
    progress.value = { running: true, fetched: 0, limit: limit.value, page: 0, done: false };
    pollTimer = setInterval(pollProgress, 1000);
  } catch (e) {
    errorText.value = classifyError(e).text;
  }
}

/**
 * 轮询采集进度
 */
async function pollProgress(): Promise<void> {
  try {
    progress.value = await sendMsg('ranking.getProgress', undefined);
    if (progress.value.done || !progress.value.running) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      await loadSnapshots();
    }
  } catch {
    // 轮询失败静默，下个周期重试
  }
}

/**
 * 取消采集（已抓部分保留并标 PARTIAL）
 */
async function cancelCollect(): Promise<void> {
  await sendMsg('ranking.cancelCollect', undefined).catch(() => undefined);
}

/**
 * 保存当前筛选为预设
 */
async function saveCurrentPreset(): Promise<void> {
  if (!presetName.value.trim()) {
    errorText.value = '请输入预设名称';
    return;
  }
  const name = presetName.value.trim();
  errorText.value = null;
  try {
    const saved = await sendMsg('rankingPreset.save', { name, source: form.value.source, query: buildQuery() });
    // 先用保存接口的返回值即时刷新界面；随后再从服务端重新读取，保证排序与多端状态一致。
    presets.value = [saved, ...presets.value.filter((p) => p.preset_id !== saved.preset_id)];
    presetName.value = '';
    presetsExpanded.value = true;
    feedback.value = `预设「${name}」已保存，已显示在下方列表。`;
    await loadPresets();
  } catch (e) {
    errorText.value = `保存预设失败：${classifyError(e).text}`;
  }
}

/** 加载账号下保存的筛选预设。 */
async function loadPresets(): Promise<void> {
  presetsLoading.value = true;
  try {
    presets.value = (await sendMsg('rankingPreset.list', { source: form.value.source })).items;
  } catch (e) {
    errorText.value = `加载预设失败：${classifyError(e).text}`;
  } finally {
    presetsLoading.value = false;
  }
}

/** 预设行辅助说明，便于区分同名之外的筛选配置。 */
function presetSummary(p: RankingPreset): string {
  const q = p.query_json as unknown as RankingQuery;
  const source = sourceLabel(q.source);
  const variant = variantLabel(String(q.rankingVariant ?? 'top-sold'));
  const seller = q.sellerType === 'cross-border' ? '跨境店' : q.sellerType === 'local' ? '本土店' : '全部店铺';
  return [source, q.region, variant, seller].filter(Boolean).join(' · ');
}

/** 全选或取消选择当前列表中的预设，用于批量采集。 */
function toggleAllPresets(): void {
  selectedPresetIds.value = allPresetsSelected.value ? [] : presets.value.map((preset) => preset.preset_id);
}

/**
 * 应用预设到表单
 * @param p 预设
 */
function applyPreset(p: RankingPreset): void {
  const q = p.query_json as unknown as RankingQuery;
  const src: RankingSource = (q.source as RankingSource) ?? 'ECHOTIK';
  // 预设携带来源平台：先切到对应 Tab，再写入该平台自己的表单状态
  activeSource.value = src;
  const f = forms[src] ?? forms.ECHOTIK;
  f.region = q.region;
  f.sellerType = q.sellerType ?? '';
  f.variant = String(q.rankingVariant ?? f.variant);
  f.timeType = String(q.rankingType ?? f.timeType);
  f.dateRange = q.dateRange ?? f.dateRange;
  f.sortBy = q.sortBy ?? '';
  f.startRank = q.startRank;
  f.endRank = q.startRank + q.limit - 1;
  const sizes = PAGE_SIZE_BY_SOURCE[src] ?? [10];
  f.perPage = sizes.includes(q.perPage as number) ? (q.perPage as number) : sizes[0]!;
  f.maxPages = q.maxPages ?? (src === 'FASTMOSS' ? 10 : 5);
  if (q.categoryId) f.cat1 = q.categoryId;
  if (q.periodStart && /^\d{8}$/.test(q.periodStart)) {
    const s = q.periodStart;
    f.date = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  if (categories.value.length === 0) void loadCategories();
}

/**
 * 删除预设
 * @param name 预设名
 */
async function removePreset(name: string): Promise<void> {
  const preset = presets.value.find((p) => p.name === name);
  if (!preset) return;
  errorText.value = null;
  try {
    await sendMsg('rankingPreset.delete', { preset_id: preset.preset_id });
    presets.value = presets.value.filter((p) => p.preset_id !== preset.preset_id);
    selectedPresetIds.value = selectedPresetIds.value.filter((id) => id !== preset.preset_id);
    feedback.value = `预设「${preset.name}」已删除。`;
  } catch (e) {
    errorText.value = `删除预设失败：${classifyError(e).text}`;
  }
}

/** 按页面展示顺序逐个执行勾选的服务端预设。 */
async function runSelectedPresets(): Promise<void> {
  const selected = presets.value.filter((p) => selectedPresetIds.value.includes(p.preset_id));
  if (!selected.length) {
    errorText.value = '请先勾选至少一个筛选预设';
    return;
  }
  presetBatchRunning.value = true;
  errorText.value = null;
  try {
    await sendMsg('ranking.runPresetBatch', { queries: selected.map((p) => p.query_json as unknown as RankingQuery) });
    presetBatchStatus.value = { running: true, current: 0, total: selected.length, completed: 0, failed: 0 };
    if (presetBatchTimer) clearInterval(presetBatchTimer);
    presetBatchTimer = setInterval(pollPresetBatch, 800);
    feedback.value = `已启动 ${selected.length} 个预设的顺序采集；每项完成后自动继续下一项。`;
  } catch (e) {
    errorText.value = classifyError(e).text;
  } finally {
    presetBatchRunning.value = false;
  }
}

/** 轮询批量预设的顺序执行状态，完成时自动停止。 */
async function pollPresetBatch(): Promise<void> {
  const state = await sendMsg('ranking.presetBatchProgress', undefined).catch(() => null);
  if (!state) return;
  presetBatchStatus.value = state;
  if (!state.running && presetBatchTimer) {
    clearInterval(presetBatchTimer);
    presetBatchTimer = null;
  }
}

/**
 * 加载历史快照列表
 */
async function loadSnapshots(): Promise<void> {
  snapLoading.value = true;
  try {
    const r = await sendMsg('snapshot.list', {
      status: snapFilter.value.status || undefined,
      source_platform: snapFilter.value.source_platform || undefined,
      date_from: snapFilter.value.date_from ? new Date(snapFilter.value.date_from).toISOString() : undefined,
      date_to: snapFilter.value.date_to ? new Date(snapFilter.value.date_to + 'T23:59:59').toISOString() : undefined,
      per_page: 20,
    });
    snapshots.value = r.items;
    snapshotTotal.value = r.total;
  } catch (e) {
    errorText.value = classifyError(e).text;
  } finally {
    snapLoading.value = false;
  }
}

/**
 * 重新获取同一榜单条件（始终创建新快照，不覆盖历史，规范 §8.2）
 * @param s 快照
 */
async function recollect(s: SnapshotSummary): Promise<void> {
  errorText.value = null;
  const fj = (s.filter_json ?? {}) as Record<string, unknown>;
  const query: RankingQuery = {
    source: (s.source_platform as RankingSource) ?? form.value.source,
    region: s.region ?? form.value.region,
    categoryId: s.category_id ?? undefined,
    rankingType: s.ranking_type ?? 'daily',
    rankingVariant: s.ranking_variant ?? 'top-sold',
    periodStart: s.period_start ?? undefined,
    periodEnd: s.period_end ?? undefined,
    dateRange: (fj.dateRange as number) ?? (s.ranking_variant === 'products' ? 7 : undefined),
    sortBy: (fj.sortBy as string) ?? undefined,
    startRank: (fj.startRank as number) ?? 1,
    limit: (fj.limit as number) ?? 100,
  };
  try {
    await sendMsg('ranking.startCollect', { query });
    feedback.value = '已按该快照条件重新启动采集（将创建新快照）。';
    progress.value = { running: true, fetched: 0, limit: query.limit, page: 0, done: false };
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollProgress, 1000);
  } catch (e) {
    errorText.value = classifyError(e).text;
  }
}

/**
 * 从快照创建 ERP 采集批次（幂等键前端生成 UUID）
 * @param s 快照
 */
async function createBatchFromSnapshot(s: SnapshotSummary): Promise<void> {
  errorText.value = null;
  try {
    const batch = await sendMsg('batch.create', {
      snapshot_id: s.snapshot_id,
      exclude_already_successful: form.value.dedup === 'EXCLUDE_SUCCESS',
      idempotency_key: uuid(),
    });
    feedback.value = `批次已创建：${batch.batch_id.slice(0, 8)}（任务 ${batch.summary?.total ?? '—'} 件${
      batch.skipped_already_successful ? `，跳过已成功 ${batch.skipped_already_successful} 件` : ''
    }）。`;
    router.push('/tasks');
  } catch (e) {
    errorText.value = classifyError(e).text;
  }
}

/**
 * 查看快照商品：跳转商品列表，并携带快照 ID + 站点 + 榜单变体 + 采集日期
 * 快照 ID 可精确锁定该次采集的商品；日期作为兜底条件
 * @param s 快照
 */
function viewSnapshotProducts(s: SnapshotSummary): void {
  const date = (s.capture_started_at ?? '').slice(0, 10);
  const query: Record<string, string> = { snapshot_id: s.snapshot_id };
  if (date) query.snapshot_date = date;
  if (s.region) query.region = s.region;
  if (s.ranking_variant) query.variant = s.ranking_variant;
  if (s.source_platform) query.source_platform = s.source_platform;
  router.push({ path: '/products', query });
}

onMounted(async () => {
  await Promise.all([loadSources(), loadCategories(), loadSnapshots(), loadPresets()]);
  // 首次进入也以当前来源页顶部站点刷新只读展示。没有打开来源页时保持静默，
  // 真正预览/采集仍会给出明确错误且后台会再次强制校验。
  void syncPageSelection(activeSource.value, true).catch(() => undefined);
  // 若进入页面时已有采集在进行，恢复进度轮询
  const p = await sendMsg('ranking.getProgress', undefined).catch(() => null);
  if (p?.running) {
    progress.value = p;
    pollTimer = setInterval(pollProgress, 1000);
  }
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
  if (presetBatchTimer) clearInterval(presetBatchTimer);
});
</script>

<template>
  <div>
    <div v-if="errorText" class="alert-bar err">{{ errorText }}</div>
    <div v-if="feedback" class="alert-bar" style="background:#f0fdf4;border-color:#bbf7d0;color:#166534">{{ feedback }}</div>

    <!-- 筛选表单 -->
    <div class="card">
      <h3>榜单筛选</h3>
      <!-- 数据来源：按渠道分 Tab，两个渠道的筛选参数各自独立 -->
      <div class="tabs">
        <button
          v-for="s in sourceTabs"
          :key="s.id"
          class="tab"
          :class="{ active: activeSource === s.id }"
          :disabled="!s.available"
          :title="s.available ? undefined : s.unavailableReason"
          @click="switchSource(s.id)"
        >
          {{ s.label }}
        </button>
      </div>
      <p v-if="form.source === 'FASTMOSS'" class="muted small" style="margin: -4px 0 8px">
        <template>
          FastMoss：先打开
          <a :href="currentSourceMeta?.boardUrl ?? 'https://www.fastmoss.com/e-commerce/saleslist'" target="_blank" rel="noreferrer">
            销量榜
          </a>
          、
          <a href="https://www.fastmoss.com/zh/e-commerce/hotlist?date_type=1&date_value=2026-11-05" target="_blank" rel="noreferrer">
            热推榜
          </a>
          、
          <a href="https://www.fastmoss.com/zh/e-commerce/newProducts?l1_cid=10&page=1" target="_blank" rel="noreferrer">
            新品榜
          </a>
          或
          <a href="https://www.fastmoss.com/zh/e-commerce/search?page=1&pagesize=10&l1_cid=10" target="_blank" rel="noreferrer">
            分类列表
          </a>
          并切换一次筛选（用于捕获接口模板），再点采集。
        </template>
      </p>

      <div class="form-row">
        <label>国家/站点</label>
        <span class="readonly-field">{{ REGION_OPTIONS.find((r) => r.value === form.region)?.label ?? form.region }}</span>
      </div>
      <p class="muted small" style="margin: -4px 0 8px">
        国家/站点始终以当前 {{ form.source === 'FASTMOSS' ? 'FastMoss' : 'EchoTik' }} 页面顶部设置为准；进入、切换来源及预览/采集前会自动同步。
      </p>

      <div class="form-row">
        <label>店铺类型</label>
        <label><input v-model="form.sellerType" type="radio" value="" /> 全部</label>
        <label><input v-model="form.sellerType" type="radio" value="cross-border" /> 跨境店</label>
        <label><input v-model="form.sellerType" type="radio" value="local" /> 本土店</label>
      </div>

      <div class="form-row" v-if="form.source === 'FASTMOSS'">
        <label>商品分类</label>
        <select v-model="form.cat1">
          <option value="">全部</option>
          <option v-for="c in cat1Options" :key="c.value" :value="c.value">{{ c.label }}</option>
        </select>
      </div>
      <div class="form-row category-pair" v-if="form.source === 'ECHOTIK'">
        <label>分类</label>
        <select v-model="form.cat1" @change="((form.cat2 = ''), (form.cat3 = ''))">
          <option value="">全部</option>
          <option v-for="c in cat1Options" :key="c.value" :value="c.value">{{ c.label }}</option>
        </select>
        <label class="secondary-label">二级分类</label>
        <select v-model="form.cat2" :disabled="!cat2Options.length" @change="form.cat3 = ''">
          <option value="">全部</option>
          <option v-for="c in cat2Options" :key="c.value" :value="c.value">{{ c.label }}</option>
        </select>
      </div>
      <div class="form-row" v-if="form.source === 'ECHOTIK' && cat3Options.length">
        <label>三级分类</label>
        <select v-model="form.cat3">
          <option value="">全部</option>
          <option v-for="c in cat3Options" :key="c.value" :value="c.value">{{ c.label }}</option>
        </select>
      </div>
      <p v-if="catLoading" class="muted small">类目加载中…</p>
      <p v-else-if="catError" class="muted small">
        类目不可用：{{ catError }} <button class="link" @click="loadCategories(true)">重试</button>
      </p>

      <div class="form-row">
        <label>榜单</label>
        <label v-for="v in variantOptions" :key="v.value" style="white-space: nowrap"><input v-model="form.variant" type="radio" :value="v.value" /> {{ variantLabel(v.value) }}</label>
      </div>
      <div class="form-row" v-if="form.variant !== 'products' && !isDateFreeFastMossVariant">
        <label>榜单周期</label>
        <label v-for="t in TIME_TYPE_OPTIONS" :key="t.value"><input v-model="form.timeType" type="radio" :value="t.value" /> {{ t.label }}</label>
      </div>
      <div class="form-row" v-else-if="form.variant === 'products'">
        <label>统计范围</label>
        <label v-for="d in DATE_RANGE_OPTIONS" :key="d.value"><input v-model.number="form.dateRange" type="radio" :value="d.value" /> {{ d.label }}</label>
      </div>

      <!-- 商品库：无榜单日期，仅统计范围 -->
      <p v-if="form.variant === 'products'" class="muted small" style="margin: -4px 0 8px">
        商品库按统计范围「近 {{ form.dateRange }} 天」指标排序，无日/周/月榜单周期。
      </p>
      <p v-else-if="isDateFreeFastMossVariant" class="muted small" style="margin: -4px 0 8px">
        带货视频榜由 FastMoss 的 rank_type=7 固定口径返回，不需要选择榜单日期。
      </p>

      <!-- 日期/周期随日/周/月切换 -->
      <div class="form-row" v-else-if="!isDateFreeFastMossVariant && form.timeType === 'daily'">
        <label>榜单日期</label>
        <input v-model="form.date" type="date" />
      </div>
      <div class="form-row" v-else-if="!isDateFreeFastMossVariant && form.timeType === 'weekly'">
        <label>榜单周期</label>
        <input v-model="form.week" type="week" />
      </div>
      <div class="form-row" v-else-if="!isDateFreeFastMossVariant">
        <label>榜单月份</label>
        <input v-model="form.month" type="month" />
      </div>
      <p v-if="form.timeType !== 'daily'" class="muted small" style="margin: -4px 0 8px">
        周/月榜真实统计周期以 EchoTik 响应为准（待验证）。
      </p>

      <div class="form-row" v-if="sortOptions.length">
        <label>排序维度</label>
        <select v-model="form.sortBy">
          <option value="">默认</option>
          <option v-for="o in sortOptions" :key="o" :value="o">{{ ORDER_FIELD_LABELS[o] ?? o }}</option>
        </select>
      </div>

      <div class="form-row range-summary-row">
        <label>排名范围</label>
        <input v-model.number="form.startRank" type="number" min="1" style="max-width: 80px" />
        <span class="muted">至</span>
        <input v-model.number="form.endRank" type="number" :min="form.startRank" style="max-width: 80px" />
        <label class="secondary-label">采集数量</label>
        <input :value="limit" type="number" disabled style="max-width: 88px" />
        <span class="muted small">由排名范围推导（默认 100）</span>
      </div>
      <div class="form-row">
        <label>去重策略</label>
        <select v-model="form.dedup">
          <option value="ALL">保留全部榜单条目</option>
          <option value="EXCLUDE_SUCCESS">仅将未成功 ERP 商品入队</option>
        </select>
      </div>

      <section class="advanced request-config">
        <button
          type="button"
          class="advanced-toggle"
          :aria-expanded="requestConfigExpanded"
          @click="requestConfigExpanded = !requestConfigExpanded"
        >
          请求配置
          <span class="muted small">{{ requestConfigExpanded ? '收起' : '展开调整' }}</span>
          <span class="toggle-chevron" :class="{ open: requestConfigExpanded }">⌄</span>
        </button>
        <div v-if="requestConfigExpanded" class="request-config-body">
          <div class="form-row">
          <label>单页数量</label>
          <select v-model.number="form.perPage" style="max-width: 90px">
            <option v-for="n in pageSizeOptions" :key="n" :value="n">{{ n }}</option>
          </select>
          <span class="muted small">{{ form.source === 'FASTMOSS' ? '默认 10（FastMoss 实测上限）' : '默认 20' }}</span>
          </div>
          <div class="form-row">
            <label>页数上限</label>
            <input v-model.number="form.maxPages" type="number" min="1" max="100" :placeholder="form.source === 'FASTMOSS' ? '默认 10' : '默认 5'" style="max-width: 80px" />
          </div>
          <p class="muted small" style="margin: 0">超时与错误退避由适配器内置（15s 超时 + 有限重试，仅正常故障恢复）。</p>
          <p class="muted small" style="margin: 4px 0 0">免费/访客套餐翻页到上限时接口会拦截，采集自动停止并保留已抓取部分（标 PARTIAL），无需重试。</p>
        </div>
      </section>

      <div class="btn-row" style="flex-wrap: wrap">
        <button class="act" @click="readPageSelection">同步当前页面筛选条件</button>
        <button class="act" :disabled="previewing" @click="doPreview">{{ previewing ? '预览中…' : '预览榜单' }}</button>
        <button class="act" :disabled="selfTesting" @click="runSelfTest">
          {{ selfTesting ? '自检中…' : `桥接自检（${variantOptions.length} 个榜单）` }}
        </button>
        <button class="primary" :disabled="progress?.running" @click="startCollect">
          {{ progress?.running ? '采集进行中…' : '获取并保存榜单' }}
        </button>
      </div>

      <!-- 预设 -->
      <div class="form-row" style="margin-top: 8px">
        <label>筛选预设</label>
        <input v-model="presetName" placeholder="预设名称" class="preset-name-input" />
        <button class="act" @click="saveCurrentPreset">保存预设</button>
        <button class="link" :disabled="presetsLoading" @click="loadPresets">{{ presetsLoading ? '加载中…' : '刷新预设' }}</button>
      </div>
      <div class="preset-toolbar">
        <button class="link" type="button" :aria-expanded="presetsExpanded" @click="presetsExpanded = !presetsExpanded">
          {{ presetsExpanded ? '收起已保存预设' : `展开已保存预设（${presets.length}）` }}
        </button>
        <button
          class="act"
          :disabled="!selectedPresetIds.length || presetBatchRunning"
          @click="runSelectedPresets"
        >{{ presetBatchRunning ? '启动中…' : `逐个采集已勾选预设（${selectedPresetIds.length}）` }}</button>
        <span class="muted small">预设按列表顺序执行；单项失败不会阻断后续项目。</span>
      </div>
      <div v-if="presetsExpanded" class="preset-table-wrap" :aria-busy="presetsLoading">
        <p v-if="presetsLoading" class="muted small">正在加载已保存的预设…</p>
        <p v-else-if="!presets.length" class="muted small">暂无已保存的预设。填写名称后点击“保存预设”，保存结果会显示在这里。</p>
        <table v-else class="list preset-table">
          <thead>
            <tr>
              <th class="preset-check"><input type="checkbox" :checked="allPresetsSelected" aria-label="全选预设" @change="toggleAllPresets" /></th>
              <th>预设名称</th><th>筛选条件</th><th>更新时间</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in presets" :key="p.preset_id">
              <td class="preset-check"><input v-model="selectedPresetIds" type="checkbox" :value="p.preset_id" :aria-label="`选择预设 ${p.name}`" /></td>
              <td><button class="link preset-name" type="button" @click="applyPreset(p)">{{ p.name }}</button></td>
              <td class="small muted">{{ presetSummary(p) }}</td>
              <td class="small muted">{{ formatTime(p.updated_at) }}</td>
              <td><button class="link preset-delete" type="button" @click="removePreset(p.name)">删除</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="presetBatchStatus.running || presetBatchStatus.total" class="muted small" style="margin:8px 0 0">
        批量采集：第 {{ presetBatchStatus.current }} / {{ presetBatchStatus.total }} 项 · 已完成 {{ presetBatchStatus.completed }} · 失败 {{ presetBatchStatus.failed }}
      </p>
    </div>

    <!-- 桥接自检结果 -->
    <div v-if="selfTestResults.length" class="card">
      <h3>桥接自检结果</h3>
      <table class="list">
        <thead><tr><th>榜单</th><th>结果</th><th>说明</th><th>耗时</th></tr></thead>
        <tbody>
          <tr v-for="r in selfTestResults" :key="r.variant">
            <td>{{ r.label }}</td>
            <td><span :class="r.ok ? 'badge ok' : 'badge err'">{{ r.ok ? '通过' : '失败' }}</span></td>
            <td class="small">{{ r.message }}</td>
            <td class="small">{{ r.ms }} ms</td>
          </tr>
        </tbody>
      </table>
      <p class="muted small">自检仅请求各接口首页 1 条，用于确认页面桥、登录态与接口路径，不写入快照。</p>
    </div>

    <!-- 采集进度 -->
    <div v-if="progress && (progress.running || progress.done)" class="card">
      <h3>采集进度</h3>
      <div class="progress" style="margin: 6px 0">
        <div :style="{ width: Math.min(100, Math.round((progress.fetched / Math.max(1, progress.limit)) * 100)) + '%' }"></div>
      </div>
      <div class="small">
        已抓 {{ progress.fetched }} / {{ progress.limit }} · 第 {{ progress.page }} 页
        <template v-if="progress.reason"> · {{ progress.done ? '结束原因' : '当前状态' }}：{{ REASON_TEXT[progress.reason] ?? progress.reason }}</template>
        <span class="muted"> · 重复与非法条目由适配器自动去重/跳过，未单独计数。</span>
      </div>
      <div class="btn-row" v-if="progress.running">
        <button class="act danger" @click="cancelCollect">取消后续分页（已抓保留并标 PARTIAL）</button>
      </div>
    </div>

    <!-- 预览结果 -->
    <div v-if="preview" class="card">
      <h3>预览（首页 {{ preview.items.length }} 条，共 {{ preview.total ?? '?' }} 条，未保存）</h3>
      <table class="list" v-if="preview.items.length">
        <thead>
          <tr><th>#</th><th>商品</th><th>商品 ID</th><th>销量</th></tr>
        </thead>
        <tbody>
          <tr v-for="it in preview.items" :key="it.external_product_id">
            <td>{{ it.rank_position }}</td>
            <td>{{ it.title }}</td>
            <td class="mono">{{ it.external_product_id }}</td>
            <td>{{ it.sales?.raw ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">当前条件下无榜单数据。</div>
    </div>

  </div>
</template>
