<script setup lang="ts">
/**
 * 榜单采集页 RankingCollector（规范 §3.3，MVP 主入口）
 * - 配置驱动筛选表单：站点（待验证标注）/三级级联类目/榜单变体×日周月/日期周期/排序维度（仅已证实值）/
 *   排名范围/采集数量（默认 200）/去重策略/请求配置折叠区
 * - 按钮：读取当前页面筛选条件 / 预览榜单（不持久化）/ 获取并保存榜单（分页进度+取消 PARTIAL）/ 保存筛选预设
 * - 历史榜单子区：筛选 + 快照行 + 查看商品/重新获取同条件/从快照创建 ERP 批次
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { browser } from 'wxt/browser';
import { sendMsg } from '@/shared/messaging';
import type {
  CategoryNode,
  ProductRankingEntry,
  RankingQuery,
  SnapshotSummary,
} from '@/shared/types';
import { deletePreset, listPresets, savePreset } from '../store';
import type { FilterPreset } from '@/shared/types';
import { classifyError, formatTime, statusBadgeClass, statusText, uuid } from '../utils';

const router = useRouter();

// ---------------- 表单状态（配置驱动，能力来自 docs/adapters/echotik-mapping.md） ----------------

/** 站点选项：接口无站点参数（待验证），以 EchoTik 页面会话为准 */
const REGION_OPTIONS = ['US', 'UK', 'ID', 'MY', 'TH', 'VN', 'PH', 'SG'];

/** 榜单变体（已证实三接口路径 + 商品库列表接口） */
const VARIANT_OPTIONS = [
  { value: 'top-sold', label: '热销榜' },
  { value: 'hot-sell', label: '热推榜' },
  { value: 'news-burst', label: '新品榜' },
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

/** 筛选表单 */
const form = ref({
  region: 'US',
  cat1: '',
  cat2: '',
  cat3: '',
  variant: 'top-sold' as string,
  timeType: 'daily' as string,
  dateRange: 7,
  date: new Date().toISOString().slice(0, 10), // yyyy-MM-dd
  week: '', // yyyy-Www
  month: '', // yyyy-MM
  sortBy: '',
  startRank: 1,
  endRank: 200,
  dedup: 'ALL' as 'ALL' | 'EXCLUDE_SUCCESS',
  // EchoTik 免费/访客套餐单页上限 10，超过会返回会员限制 HTML
  perPage: 10,
  maxPages: 20,
});

/** 单页数量可选项（接口按会员套餐限制，免费仅支持 10 条/页） */
const PAGE_SIZE_OPTIONS = [10] as const;

/** 类目树（background 抓取 + 缓存） */
const categories = ref<CategoryNode[]>([]);
const catLoading = ref(false);
const catError = ref<string | null>(null);

/** 级联类目选项 */
const cat1Options = computed(() => categories.value);
const cat2Options = computed(() => cat1Options.value.find((c) => c.value === form.value.cat1)?.children ?? []);
const cat3Options = computed(() => cat2Options.value.find((c) => c.value === form.value.cat2)?.children ?? []);

/** 当前变体可用的排序维度（仅已证实值） */
const sortOptions = computed(() => ORDER_FIELDS_BY_VARIANT[form.value.variant] ?? []);

/** 采集数量（由排名范围推导） */
const limit = computed(() => Math.max(1, form.value.endRank - form.value.startRank + 1));

/** 结束原因文案 */
const REASON_TEXT: Record<string, string> = {
  REACHED_LIMIT: '达到采集数量',
  NO_MORE_PAGES: '接口无更多页',
  EMPTY_PAGE: '返回空页',
  DUPLICATE_PAGE: '连续重复页',
  CANCELLED: '用户取消（已保存部分标 PARTIAL）',
  PERMISSION_LIMIT: '会员/访客权限限制，已保存已抓部分（PARTIAL）',
  MAX_PAGES: '达到页数上限',
  UPLOAD_PARTIAL: '部分上传失败（标 PARTIAL）',
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
const presets = ref<FilterPreset[]>([]);
const presetName = ref('');
/** 历史快照 */
const snapshots = ref<SnapshotSummary[]>([]);
const snapshotTotal = ref(0);
const snapFilter = ref({ status: '', date_from: '', date_to: '' });
const snapLoading = ref(false);

/**
 * 将表单转换为 RankingQuery
 * - 榜单三接口：日期按日/周/月切换为 time_range=yyyyMMdd
 * - 商品库接口：无 time_range，改用 dateRange（7/30 天），rankingType 固定 products
 */
function buildQuery(): RankingQuery {
  const f = form.value;
  const categoryId = f.cat3 || f.cat2 || f.cat1 || undefined;
  // 页数上限按目标条数动态计算，避免每页 10 条时提前触发 MAX_PAGES
  const maxPages = Math.max(f.maxPages, Math.ceil(limit.value / Math.max(1, f.perPage)) + 1);
  if (f.variant === 'products') {
    return {
      region: f.region,
      categoryId,
      rankingType: 'products',
      rankingVariant: f.variant,
      dateRange: f.dateRange,
      sortBy: f.sortBy || undefined,
      startRank: f.startRank,
      limit: limit.value,
      perPage: f.perPage,
      maxPages,
    };
  }
  let periodStart: string | undefined;
  if (f.timeType === 'daily' && f.date) {
    periodStart = f.date.replaceAll('-', '');
  } else if (f.timeType === 'weekly' && f.week) {
    // ISO 周 → 周一日期（yyyyMMdd）；周榜真实统计周期以接口响应为准（待验证）
    const [y, w] = f.week.split('-W').map(Number);
    const d = new Date(Date.UTC(y!, 0, 4));
    d.setUTCDate(d.getUTCDate() + (w! - 1) * 7 - ((d.getUTCDay() + 6) % 7));
    periodStart = d.toISOString().slice(0, 10).replace(/-/g, '');
  } else if (f.timeType === 'monthly' && f.month) {
    periodStart = f.month.replace('-', '') + '01'; // 月榜取当月首日（待验证）
  }
  return {
    region: f.region,
    categoryId,
    rankingType: f.timeType,
    rankingVariant: f.variant,
    periodStart,
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
    const r = await sendMsg('echotik.getCategories', { force });
    categories.value = r.items;
  } catch (e) {
    catError.value = classifyError(e).text;
  } finally {
    catLoading.value = false;
  }
}

/**
 * 读取当前 EchoTik 页面筛选条件（直连 content script）
 */
async function readPageSelection(): Promise<void> {
  feedback.value = null;
  errorText.value = null;
  try {
    const tabs = await browser.tabs.query({ url: ['https://echotik.live/*', 'https://*.echotik.live/*'] });
    // 登录 Cookie 仅挂在 echotik.live 主域，优先主域页面（www 子域没有登录态）
    const isMain = (t: (typeof tabs)[number]): boolean => /^https:\/\/echotik\.live(\/|$)/.test(t.url ?? '');
    const tab = tabs.filter((t) => t.id != null).sort((a, b) => Number(isMain(b)) - Number(isMain(a)))[0];
    if (!tab || tab.id == null) throw new Error('ECHOTIK_NETWORK: 未找到 EchoTik 页面，请先打开榜单页');
    const sel = await sendMsg('echotik.readPageSelection', undefined, tab.id);
    // 仅应用页面真实读到的字段，不做猜测填充
    if (sel.region) form.value.region = sel.region;
    if (sel.rankingType) form.value.timeType = String(sel.rankingType).toLowerCase();
    if (sel.rankingVariant) form.value.variant = String(sel.rankingVariant);
    if (sel.categoryId) form.value.cat1 = sel.categoryId;
    if (sel.periodStart && /^\d{8}$/.test(sel.periodStart)) {
      const p = sel.periodStart;
      form.value.date = `${p.slice(0, 4)}-${p.slice(4, 6)}-${p.slice(6, 8)}`;
    }
    if (sel.sortBy) form.value.sortBy = sel.sortBy;
    feedback.value = '已读取当前页面筛选条件（未读取到的字段保持原值）。';
  } catch (e) {
    errorText.value = classifyError(e).text;
  }
}

/**
 * 预览榜单：抓首页展示，不持久化
 */
async function doPreview(): Promise<void> {
  previewing.value = true;
  preview.value = null;
  errorText.value = null;
  try {
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
      region: f.region,
      categoryId,
      rankingType: 'products',
      rankingVariant: variant,
      dateRange: f.dateRange || 7,
      startRank: 1,
      limit: 1,
      perPage: 1,
    };
  }
  return {
    region: f.region,
    categoryId,
    rankingType: f.timeType,
    rankingVariant: variant,
    periodStart: f.date ? f.date.replaceAll('-', '') : undefined,
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
    for (const v of VARIANT_OPTIONS) {
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

/**
 * 获取并保存榜单：启动后台采集并轮询进度；结束后停止轮询
 */
async function startCollect(): Promise<void> {
  errorText.value = null;
  feedback.value = null;
  try {
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
  presets.value = await savePreset({
    name: presetName.value.trim(),
    query: buildQuery(),
    saved_at: new Date().toISOString(),
  });
  feedback.value = `预设「${presetName.value.trim()}」已保存。`;
  presetName.value = '';
}

/**
 * 应用预设到表单
 * @param p 预设
 */
function applyPreset(p: FilterPreset): void {
  const q = p.query;
  form.value.region = q.region;
  form.value.variant = String(q.rankingVariant ?? 'top-sold');
  form.value.timeType = String(q.rankingType ?? 'daily');
  form.value.dateRange = q.dateRange ?? 7;
  form.value.sortBy = q.sortBy ?? '';
  form.value.startRank = q.startRank;
  form.value.endRank = q.startRank + q.limit - 1;
  form.value.perPage = PAGE_SIZE_OPTIONS.includes(q.perPage as (typeof PAGE_SIZE_OPTIONS)[number])
    ? (q.perPage as number)
    : 50;
  form.value.maxPages = q.maxPages ?? 10;
  if (q.categoryId) form.value.cat1 = q.categoryId;
  if (q.periodStart && /^\d{8}$/.test(q.periodStart)) {
    const s = q.periodStart;
    form.value.date = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
}

/**
 * 删除预设
 * @param name 预设名
 */
async function removePreset(name: string): Promise<void> {
  presets.value = await deletePreset(name);
}

/**
 * 加载历史快照列表
 */
async function loadSnapshots(): Promise<void> {
  snapLoading.value = true;
  try {
    const r = await sendMsg('snapshot.list', {
      status: snapFilter.value.status || undefined,
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
    region: s.region ?? form.value.region,
    categoryId: s.category_id ?? undefined,
    rankingType: s.ranking_type ?? 'daily',
    rankingVariant: s.ranking_variant ?? 'top-sold',
    periodStart: s.period_start ?? undefined,
    periodEnd: s.period_end ?? undefined,
    dateRange: (fj.dateRange as number) ?? (s.ranking_variant === 'products' ? 7 : undefined),
    sortBy: (fj.sortBy as string) ?? undefined,
    startRank: (fj.startRank as number) ?? 1,
    limit: (fj.limit as number) ?? 200,
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
 * 查看快照商品：跳转商品列表并按快照采集日期过滤
 * @param s 快照
 */
function viewSnapshotProducts(s: SnapshotSummary): void {
  const date = (s.capture_started_at ?? '').slice(0, 10);
  router.push({ path: '/products', query: date ? { snapshot_date: date } : {} });
}

onMounted(async () => {
  await Promise.all([loadCategories(), loadSnapshots(), listPresets().then((p) => (presets.value = p))]);
  // 若进入页面时已有采集在进行，恢复进度轮询
  const p = await sendMsg('ranking.getProgress', undefined).catch(() => null);
  if (p?.running) {
    progress.value = p;
    pollTimer = setInterval(pollProgress, 1000);
  }
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
  <div>
    <div v-if="errorText" class="alert-bar err">{{ errorText }}</div>
    <div v-if="feedback" class="alert-bar" style="background:#f0fdf4;border-color:#bbf7d0;color:#166534">{{ feedback }}</div>

    <!-- 筛选表单 -->
    <div class="card">
      <h3>榜单筛选</h3>
      <div class="form-row">
        <label>国家/站点</label>
        <select v-model="form.region">
          <option v-for="r in REGION_OPTIONS" :key="r" :value="r">{{ r }}</option>
        </select>
      </div>
      <p class="muted small" style="margin: -4px 0 8px">站点为待验证字段：接口无站点参数，实际以 EchoTik 页面会话为准。</p>

      <div class="form-row">
        <label>分类</label>
        <select v-model="form.cat1" @change="((form.cat2 = ''), (form.cat3 = ''))">
          <option value="">全部</option>
          <option v-for="c in cat1Options" :key="c.value" :value="c.value">{{ c.label }}</option>
        </select>
      </div>
      <div class="form-row" v-if="cat2Options.length">
        <label>二级分类</label>
        <select v-model="form.cat2" @change="form.cat3 = ''">
          <option value="">全部</option>
          <option v-for="c in cat2Options" :key="c.value" :value="c.value">{{ c.label }}</option>
        </select>
      </div>
      <div class="form-row" v-if="cat3Options.length">
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
        <select v-model="form.variant">
          <option v-for="v in VARIANT_OPTIONS" :key="v.value" :value="v.value">{{ v.label }}</option>
        </select>
        <select v-model="form.timeType" v-if="form.variant !== 'products'" style="max-width: 90px">
          <option v-for="t in TIME_TYPE_OPTIONS" :key="t.value" :value="t.value">{{ t.label }}</option>
        </select>
        <select v-model.number="form.dateRange" v-else style="max-width: 110px">
          <option v-for="d in DATE_RANGE_OPTIONS" :key="d.value" :value="d.value">{{ d.label }}</option>
        </select>
      </div>

      <!-- 商品库：无榜单日期，仅统计范围 -->
      <p v-if="form.variant === 'products'" class="muted small" style="margin: -4px 0 8px">
        商品库按统计范围「近 {{ form.dateRange }} 天」指标排序，无日/周/月榜单周期。
      </p>

      <!-- 日期/周期随日/周/月切换 -->
      <div class="form-row" v-else-if="form.timeType === 'daily'">
        <label>榜单日期</label>
        <input v-model="form.date" type="date" />
      </div>
      <div class="form-row" v-else-if="form.timeType === 'weekly'">
        <label>榜单周期</label>
        <input v-model="form.week" type="week" />
      </div>
      <div class="form-row" v-else>
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

      <div class="form-row">
        <label>排名范围</label>
        <input v-model.number="form.startRank" type="number" min="1" style="max-width: 80px" />
        <span class="muted">至</span>
        <input v-model.number="form.endRank" type="number" :min="form.startRank" style="max-width: 80px" />
      </div>
      <div class="form-row">
        <label>采集数量</label>
        <input :value="limit" type="number" disabled />
        <span class="muted small">由排名范围推导（默认 200）</span>
      </div>
      <div class="form-row">
        <label>去重策略</label>
        <select v-model="form.dedup">
          <option value="ALL">保留全部榜单条目</option>
          <option value="EXCLUDE_SUCCESS">仅将未成功 ERP 商品入队</option>
        </select>
      </div>

      <fieldset class="advanced">
        <legend>请求配置</legend>
        <div class="form-row">
          <label>单页数量</label>
          <select v-model.number="form.perPage" style="max-width: 90px">
            <option v-for="n in PAGE_SIZE_OPTIONS" :key="n" :value="n">{{ n }}</option>
          </select>
          <span class="muted small">接口上限 50</span>
        </div>
        <div class="form-row">
          <label>页数上限</label>
          <input v-model.number="form.maxPages" type="number" min="1" max="100" placeholder="默认 10" style="max-width: 80px" />
        </div>
        <p class="muted small" style="margin: 0">超时与错误退避由适配器内置（15s 超时 + 有限重试，仅正常故障恢复）。</p>
        <p class="muted small" style="margin: 4px 0 0">免费/访客套餐翻页到上限时接口会拦截，采集自动停止并保留已抓取部分（标 PARTIAL），无需重试。</p>
      </fieldset>

      <div class="btn-row" style="flex-wrap: wrap">
        <button class="act" @click="readPageSelection">读取当前页面筛选条件</button>
        <button class="act" :disabled="previewing" @click="doPreview">{{ previewing ? '预览中…' : '预览榜单' }}</button>
        <button class="act" :disabled="selfTesting" @click="runSelfTest">{{ selfTesting ? '自检中…' : '桥接自检（4 个榜单）' }}</button>
        <button class="primary" :disabled="progress?.running" @click="startCollect">
          {{ progress?.running ? '采集进行中…' : '获取并保存榜单' }}
        </button>
      </div>

      <!-- 预设 -->
      <div class="form-row" style="margin-top: 8px">
        <label>筛选预设</label>
        <input v-model="presetName" placeholder="预设名称" style="max-width: 140px" />
        <button class="act" @click="saveCurrentPreset">保存预设</button>
      </div>
      <div v-if="presets.length" class="small" style="display: flex; flex-wrap: wrap; gap: 6px">
        <span v-for="p in presets" :key="p.name" class="badge info" style="cursor: pointer" @click="applyPreset(p)">
          {{ p.name }}
          <button class="link" style="color: #b91c1c" @click.stop="removePreset(p.name)">×</button>
        </span>
      </div>
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
        <template v-if="progress.done"> · 结束原因：{{ REASON_TEXT[progress.reason ?? ''] ?? progress.reason ?? '—' }}</template>
      </div>
      <p class="muted small">重复与非法条目由适配器自动去重/跳过，未单独计数。</p>
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

    <!-- 历史榜单子区 -->
    <div class="section-title">历史榜单（共 {{ snapshotTotal }} 个快照）</div>
    <div class="card">
      <div class="form-row">
        <label>状态</label>
        <select v-model="snapFilter.status" @change="loadSnapshots">
          <option value="">全部</option>
          <option value="COMPLETED">完成</option>
          <option value="PARTIAL">部分完成</option>
          <option value="FAILED">失败</option>
        </select>
      </div>
      <div class="form-row">
        <label>采集日期</label>
        <input v-model="snapFilter.date_from" type="date" @change="loadSnapshots" />
        <input v-model="snapFilter.date_to" type="date" @change="loadSnapshots" />
      </div>
      <div v-if="snapLoading" class="muted small">加载中…</div>
      <div v-else-if="!snapshots.length" class="empty">暂无历史快照。配置筛选条件后点击「获取并保存榜单」。</div>
      <table v-else class="list">
        <thead>
          <tr><th>快照</th><th>榜单/周期</th><th>行数</th><th>采集时间</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="s in snapshots" :key="s.snapshot_id">
            <td class="mono">{{ s.snapshot_id.slice(0, 8) }}</td>
            <td class="small">
              {{ VARIANT_OPTIONS.find((v) => v.value === s.ranking_variant)?.label ?? s.ranking_variant ?? '—' }}
              <template v-if="s.ranking_variant !== 'products'"> / {{ s.ranking_type ?? '—' }}</template>
              <div class="muted">{{ s.period_start ?? '—' }}</div>
            </td>
            <td>{{ s.total_entries ?? '—' }}</td>
            <td class="small">{{ formatTime(s.capture_started_at) }}</td>
            <td><span :class="statusBadgeClass(s.status)">{{ statusText(s.status) }}</span></td>
            <td>
              <button class="link" @click="viewSnapshotProducts(s)">查看商品</button>
              <button class="link" @click="recollect(s)">重新获取</button>
              <button class="link" @click="createBatchFromSnapshot(s)">创建 ERP 批次</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
