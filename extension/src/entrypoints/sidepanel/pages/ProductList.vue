<script setup lang="ts">
/**
 * 商品列表页 ProductList（规范 §3.4，数据源改为本地采集记录）
 * - 数据只来自 IndexedDB `local_products`（每次榜单采集写入），不请求服务端商品列表
 * - 过滤：关键词/国家/分类/榜单变体/批次/采集日期/排名范围；本地排序与分页
 * - 行操作：单件采集（建单商品批次并立即启动，测试 TikTok 详情页 + 妙手 ERP）、打开 TikTok 商品页；批量：导出 CSV
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { browser } from 'wxt/browser';
import { sendMsg } from '@/shared/messaging';
import type { BatchItem, CategoryNode, Paginated, ProductItem } from '@/shared/types';
import { classifyError, downloadText, formatTime, toCsv } from '../utils';

const route = useRoute();
const router = useRouter();

/** 榜单变体选项（与采集页保持一致） */
const VARIANT_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'top-sold', label: '热销榜' },
  { value: 'hot-sell', label: '热推榜' },
  { value: 'news-burst', label: '新品榜' },
  { value: 'products', label: '商品库' },
];

/** 本地可用的排序字段 */
const SORT_OPTIONS = [
  { value: 'collected_at', label: '最近采集' },
  { value: 'rank_position', label: '榜单排名' },
  { value: 'title', label: '名称' },
];

/** 过滤条件 */
const filter = ref({
  keyword: '',
  region: '',
  category: '',
  ranking_variant: '',
  batch_id: '',
  date_from: '',
  date_to: '',
  rank_min: null as number | null,
  rank_max: null as number | null,
});
/** 排序与分页 */
const sort = ref('collected_at');
const order = ref<'asc' | 'desc'>('desc');
const page = ref(1);
const perPage = ref(20);

/** 列表数据 */
const data = ref<Paginated<ProductItem> | null>(null);
const loading = ref(false);
const errorText = ref<string | null>(null);
const feedback = ref<string | null>(null);

/** 类目树（用于分类筛选下拉） */
const categories = ref<CategoryNode[]>([]);

/** 批次下拉数据（最近 100 个批次，标签带榜单信息便于识别） */
const batchOptions = ref<{ value: string; label: string }[]>([]);
const batchLoading = ref(false);

const VARIANT_LABELS: Record<string, string> = {
  'top-sold': '热销榜',
  'hot-sell': '热推榜',
  'news-burst': '新品榜',
  products: '商品库',
};
const TYPE_LABELS: Record<string, string> = { daily: '日榜', weekly: '周榜', monthly: '月榜' };

/**
 * 批次下拉标签：批次号 + 站点/榜单/类型/日期（优先取快照信息）
 * @param b 批次
 */
function batchLabel(b: BatchItem): string {
  const s = b.snapshot;
  const id = b.batch_id.slice(0, 8);
  if (!s) return `batch_${id}`;
  const fmt = (v?: string | null): string => {
    if (!v) return '';
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : v;
  };
  const parts = [
    (s.region ?? '').toUpperCase(),
    VARIANT_LABELS[s.ranking_variant ?? ''] ?? s.ranking_variant ?? '',
    TYPE_LABELS[s.ranking_type ?? ''] ?? s.ranking_type ?? '',
    fmt(s.period_start),
  ].filter(Boolean);
  return `batch_${id}${parts.length ? ` · ${parts.join(' ')}` : ''}`;
}

/**
 * 加载批次下拉（最近 100 个，按创建时间倒序）
 */
async function loadBatches(): Promise<void> {
  batchLoading.value = true;
  try {
    const r = await sendMsg('batch.list', { page: 1, per_page: 100 });
    batchOptions.value = r.items.map((b) => ({ value: b.batch_id, label: batchLabel(b) }));
  } catch {
    batchOptions.value = [];
  } finally {
    batchLoading.value = false;
  }
}

/** 分类下拉：按一级类目分组，选项文本为中文路径（一级 / 二级 / 三级） */
const categoryGroups = computed(() => {
  /** 递归展开子类目，产出中文相对路径 */
  const flatten = (nodes: CategoryNode[], prefix: string[]): { value: string; text: string }[] => {
    const out: { value: string; text: string }[] = [];
    for (const n of nodes) {
      const label = (n.label ?? '').trim();
      if (!label) continue;
      const path = [...prefix, label];
      out.push({ value: label, text: path.join(' / ') });
      if (n.children?.length) out.push(...flatten(n.children, path));
    }
    return out;
  };
  return categories.value
    .filter((top) => (top.label ?? '').trim() && top.value !== '' && top.children?.length)
    .map((top) => ({
      label: top.label as string,
      options: [
        { value: top.label as string, text: `全部${top.label}` },
        ...flatten(top.children ?? [], []),
      ],
    }));
});

/**
 * 查询参数（本地消息 payload）
 */
function buildPayload(p: number, size: number) {
  return {
    keyword: filter.value.keyword || undefined,
    region: filter.value.region || undefined,
    category: filter.value.category || undefined,
    ranking_variant: filter.value.ranking_variant || undefined,
    date_from: filter.value.date_from ? new Date(filter.value.date_from).toISOString() : undefined,
    date_to: filter.value.date_to ? new Date(filter.value.date_to + 'T23:59:59').toISOString() : undefined,
    rank_min: filter.value.rank_min ?? undefined,
    rank_max: filter.value.rank_max ?? undefined,
    batch_id: filter.value.batch_id || undefined,
    sort: sort.value,
    order: order.value,
    page: p,
    per_page: size,
  };
}

/**
 * 加载本地商品列表
 */
async function load(): Promise<void> {
  loading.value = true;
  errorText.value = null;
  try {
    data.value = await sendMsg('product.listLocal', buildPayload(page.value, perPage.value));
  } catch (e) {
    errorText.value = classifyError(e).text;
    data.value = null;
  } finally {
    loading.value = false;
  }
}

/**
 * 应用筛选（重置到第一页）
 */
function applyFilter(): void {
  page.value = 1;
  void load();
}

/**
 * 打开 TikTok 商品页
 * @param p 商品
 */
async function openTikTok(p: ProductItem): Promise<void> {
  const url = p.detail_url ?? `https://www.tiktok.com/shop/pdp/${p.external_product_id}`;
  await browser.tabs.create({ url });
}

/** 正在单件采集的商品 key（`region:external_product_id`） */
const collectingKey = ref<string | null>(null);

/**
 * 单件商品直接采集（测试 TikTok 详情页 + 妙手 ERP 链路）
 * 由 background 解析服务端商品 → 建单商品批次（强制重抓）→ 启动并领取
 * @param p 商品
 */
async function collectOne(p: ProductItem): Promise<void> {
  const key = `${p.region ?? ''}:${p.external_product_id}`;
  if (collectingKey.value) return;
  errorText.value = null;
  feedback.value = null;
  collectingKey.value = key;
  try {
    const region = p.region ?? filter.value.region ?? 'US';
    const r = await sendMsg('product.collectSingle', {
      external_product_id: p.external_product_id,
      region,
    });
    feedback.value = `已创建并开始采集：${r.batch_id}（单商品，强制重抓）。可在「任务」页查看进度。`;
  } catch (e) {
    errorText.value = classifyError(e).text;
  } finally {
    collectingKey.value = null;
  }
}

/**
 * 导出 CSV：按当前过滤条件分页拉取本地记录（最多 500 条）
 */
async function exportCsv(): Promise<void> {
  errorText.value = null;
  try {
    const rows: ProductItem[] = [];
    for (let p = 1; p <= 5; p++) {
      const r = await sendMsg('product.listLocal', buildPayload(p, 100));
      rows.push(...r.items);
      if (rows.length >= r.total) break;
    }
    const csv = toCsv(
      ['商品ID', 'TikTok商品ID', '站点', '店铺', '类目', '排名', '采集时间', '详情URL'],
      rows.map((p) => [
        p.id,
        p.external_product_id,
        p.region ?? '',
        p.shop_name ?? '',
        (p.raw_excerpt?.category as string) ?? '',
        String((p.raw_excerpt?.rank_position as number) ?? ''),
        p.last_seen_at ?? '',
        p.detail_url ?? '',
      ]),
    );
    downloadText(`local-products-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    feedback.value = `已导出 ${rows.length} 条本地采集记录（当前过滤条件，单次上限 500 条）。`;
  } catch (e) {
    errorText.value = classifyError(e).text;
  }
}

watch([page, perPage, sort, order], () => void load());

onMounted(async () => {
  const sd = route.query.snapshot_date;
  if (typeof sd === 'string' && sd) {
    filter.value.date_from = sd;
    filter.value.date_to = sd;
  }
  // 从批次任务页跳转过来：携带批次过滤条件（批次 + 站点 + 榜单变体）
  const qb = route.query.batch_id;
  if (typeof qb === 'string' && qb) filter.value.batch_id = qb;
  const qr = route.query.region;
  if (typeof qr === 'string' && qr) filter.value.region = qr;
  const qv = route.query.variant;
  if (typeof qv === 'string' && qv) filter.value.ranking_variant = qv;
  await sendMsg('echotik.getCategories', undefined)
    .then((r) => (categories.value = r.items))
    .catch(() => undefined);
  await loadBatches();
  await load();
});
</script>

<template>
  <div>
    <div v-if="errorText" class="alert-bar err">{{ errorText }}</div>
    <div v-if="feedback" class="alert-bar" style="background:#f0fdf4;border-color:#bbf7d0;color:#166534">
      {{ feedback }}
      <button class="link" style="margin-left: 8px" @click="router.push({ path: '/tasks' })">去任务页</button>
    </div>

    <!-- 顶部过滤 -->
    <div class="card">
      <p class="muted small" style="margin: 0 0 8px">
        数据来源：本地采集记录（IndexedDB），仅包含你在「榜单采集」页抓取过的商品，不读取服务端商品列表。
      </p>
      <div class="form-row">
        <label>关键词</label>
        <input v-model="filter.keyword" placeholder="名称 / TikTok ID / 店铺" @keyup.enter="applyFilter" />
      </div>
      <div class="form-row">
        <label>国家</label>
        <select v-model="filter.region" @change="applyFilter">
          <option value="">全部</option>
          <option v-for="r in ['US', 'UK', 'ID', 'MY', 'TH', 'VN', 'PH', 'SG']" :key="r" :value="r">{{ r }}</option>
        </select>
        <label style="width: auto">分类</label>
        <select v-model="filter.category" @change="applyFilter">
          <option value="">全部</option>
          <optgroup v-for="g in categoryGroups" :key="g.label" :label="g.label">
            <option v-for="o in g.options" :key="o.value" :value="o.value">{{ o.text }}</option>
          </optgroup>
        </select>
      </div>
      <div class="form-row">
        <label>榜单</label>
        <select v-model="filter.ranking_variant" @change="applyFilter">
          <option v-for="o in VARIANT_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </div>
      <div class="form-row">
        <label>批次</label>
        <select v-model="filter.batch_id" @change="applyFilter">
          <option value="">全部批次</option>
          <option v-for="o in batchOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <button class="act" :disabled="batchLoading" @click="loadBatches">
          {{ batchLoading ? '加载中…' : '刷新批次' }}
        </button>
      </div>
      <div class="form-row">
        <label>采集日期</label>
        <input v-model="filter.date_from" type="date" @change="applyFilter" />
        <input v-model="filter.date_to" type="date" @change="applyFilter" />
      </div>
      <div class="form-row">
        <label>排名范围</label>
        <input v-model.number="filter.rank_min" type="number" min="1" placeholder="起" style="max-width: 70px" @change="applyFilter" />
        <input v-model.number="filter.rank_max" type="number" min="1" placeholder="止" style="max-width: 70px" @change="applyFilter" />
        <button class="act" @click="applyFilter">查询</button>
      </div>
      <div class="form-row">
        <label>排序</label>
        <select v-model="sort">
          <option v-for="o in SORT_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <select v-model="order" style="max-width: 90px">
          <option value="desc">降序</option>
          <option value="asc">升序</option>
        </select>
      </div>
    </div>

    <!-- 商品表格 -->
    <div class="card" style="padding: 8px">
      <div v-if="loading" class="muted small" style="padding: 12px">加载中…</div>
      <div v-else-if="!data || !data.items.length" class="empty">
        <template v-if="filter.batch_id">
          该批次没有匹配的本地商品：本地商品库只记录榜单采集过的商品，可能该批次商品来自其他机器或尚未在本地采集。
        </template>
        <template v-else>
          本地还没有采集记录。请先在「榜单采集」页抓取榜单，采集结果会写入本地商品库。
        </template>
      </div>
      <template v-else>
        <table class="list">
          <thead>
            <tr>
              <th>图</th><th>商品</th><th>站点</th><th>店铺</th><th>类目</th><th>排名</th><th>采集时间</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in data.items" :key="p.id">
              <td><img v-if="p.image_url" :src="p.image_url" class="thumb" alt="" /><span v-else class="muted">—</span></td>
              <td>
                <div>{{ p.title ?? '—' }}</div>
                <div class="mono muted">{{ p.external_product_id }}</div>
              </td>
              <td>{{ p.region ?? '—' }}</td>
              <td class="small">{{ p.shop_name ?? '—' }}</td>
              <td class="small">{{ (p.raw_excerpt?.category as string) ?? '—' }}</td>
              <td class="small">{{ (p.raw_excerpt?.rank_position as number) ?? '—' }}</td>
              <td class="small">{{ formatTime(p.last_seen_at) }}</td>
              <td style="white-space: nowrap">
                <button
                  class="act"
                  :disabled="!!collectingKey"
                  @click="collectOne(p)"
                >{{ collectingKey === `${p.region ?? ''}:${p.external_product_id}` ? '采集中…' : '采集' }}</button>
                <button class="link" @click="openTikTok(p)">打开</button>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="pager">
          <button class="act" :disabled="page <= 1" @click="page--">上一页</button>
          <span>第 {{ data.page }} 页 / 共 {{ data.total }} 条</span>
          <button class="act" :disabled="page * perPage >= data.total" @click="page++">下一页</button>
          <select v-model.number="perPage">
            <option :value="20">20/页</option>
            <option :value="50">50/页</option>
            <option :value="100">100/页</option>
          </select>
        </div>
      </template>
    </div>

    <!-- 导出 -->
    <div class="card">
      <h3>导出</h3>
      <div class="btn-row" style="flex-wrap: wrap">
        <button class="act" @click="exportCsv">导出 CSV（当前过滤条件）</button>
      </div>
    </div>
  </div>
</template>
