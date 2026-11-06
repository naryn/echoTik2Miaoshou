<script setup lang="ts">
/**
 * 商品列表页 ProductList（规范 §3.4，数据统一来源于服务端）
 * - 数据只来自服务端商品接口：普通账号仅返回自己快照/批次涉及的商品，管理员返回全量
 * - 通用过滤：关键词/来源渠道/站点/入库时间；渠道特有条件仅由内部跳转上下文携带
 * - 行操作：单件采集（建单商品批次并立即启动，测试 TikTok 详情页 + 妙手 ERP）、打开 TikTok 商品页；批量：导出 CSV
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { browser } from 'wxt/browser';
import { sendMsg } from '@/shared/messaging';
import type { Paginated, ProductItem } from '@/shared/types';
import { store } from '../store';
import { classifyError, downloadText, formatTime, toCsv } from '../utils';

const route = useRoute();
const router = useRouter();

/** 是否管理员角色：开启后切换为远端全量商品，普通用户则读取服务端自身数据 */
const isAdmin = computed(() => store.state?.role === 'ADMIN');

/** 本地可用的排序字段 */
const SORT_OPTIONS = [
  { value: 'collected_at', label: '最近采集' },
  { value: 'title', label: '名称' },
];

/** 过滤条件 */
const filter = ref({
  keyword: '',
  region: '',
  category: '',
  ranking_variant: '',
  /** 榜单来源平台（ECHOTIK / FASTMOSS / 空=全部） */
  source_platform: '',
  batch_id: '',
  snapshot_id: '',
  date_from: '',
  date_to: '',
  rank_min: null as number | null,
  rank_max: null as number | null,
});

/** 来源平台选项（来自 background 注册表，便于后续扩展） */
const sources = ref<{ id: string; label: string }[]>([]);

/**
 * 加载来源平台列表
 */
async function loadSources(): Promise<void> {
  try {
    const r = await sendMsg('ranking.sources', undefined);
    sources.value = r.items.map((s) => ({ id: s.id, label: s.label }));
  } catch {
    sources.value = [
      { id: 'ECHOTIK', label: 'EchoTik' },
      { id: 'FASTMOSS', label: 'FastMoss' },
    ];
  }
}

/**
 * 来源平台展示名（缺省视为 EchoTik）
 * @param p 平台标识
 */
function sourceLabel(p?: string | null): string {
  const id = p ?? 'ECHOTIK';
  return sources.value.find((s) => s.id === id)?.label ?? id;
}

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

/** 当前在大图预览中展示的商品图片 URL。 */
const previewImageUrl = ref<string | null>(null);

/** 当前生效的跳转筛选标签（用于显式提示，避免被误认为没过滤） */
const activeJumpFilters = computed(() => {
  const tags: { key: 'batch' | 'snapshot'; text: string }[] = [];
  if (filter.value.batch_id) tags.push({ key: 'batch', text: `批次 ${filter.value.batch_id.slice(0, 8)}` });
  if (filter.value.snapshot_id) tags.push({ key: 'snapshot', text: `快照 ${filter.value.snapshot_id.slice(0, 8)}` });
  return tags;
});

/**
 * 清除某个跳转带入的筛选条件
 * @param key 条件类型
 */
function clearJumpFilter(key: 'batch' | 'snapshot'): void {
  if (key === 'batch') filter.value.batch_id = '';
  else filter.value.snapshot_id = '';
  void router.replace({ path: '/products' });
  applyFilter();
}

/**
 * 远程商品查询参数（普通账号与服务端商品接口共用）
 * 说明：「采集日期」映射为服务端快照日期；「最近采集」排序映射为 last_seen_at。
 */
function buildPayload(p: number, size: number) {
  const dateFrom = filter.value.date_from ? new Date(filter.value.date_from).toISOString() : undefined;
  const dateTo = filter.value.date_to
    ? new Date(filter.value.date_to + 'T23:59:59').toISOString()
    : undefined;
  return {
    keyword: filter.value.keyword || undefined,
    region: filter.value.region || undefined,
    category: filter.value.category || undefined,
    ranking_variant: filter.value.ranking_variant || undefined,
    source_platform: filter.value.source_platform || undefined,
    snapshot_id: filter.value.snapshot_id || undefined,
    batch_id: filter.value.batch_id || undefined,
    snapshot_date_from: dateFrom,
    snapshot_date_to: dateTo,
    rank_min: filter.value.rank_min ?? undefined,
    rank_max: filter.value.rank_max ?? undefined,
    sort: sort.value === 'collected_at' ? 'last_seen_at' : sort.value,
    order: order.value,
    page: p,
    per_page: size,
  };
}

/**
 * 加载商品列表
 * 数据统一来自服务端：普通账号仅返回自身快照/批次涉及的商品，管理员返回全量
 */
async function load(): Promise<void> {
  loading.value = true;
  errorText.value = null;
  try {
    data.value = isAdmin.value
      ? await sendMsg('admin.listProducts', buildPayload(page.value, perPage.value))
      : await sendMsg('product.list', buildPayload(page.value, perPage.value));
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
  // 空字符串会被 Chrome 当成扩展自身的首页，最终打开 chrome-extension://<id>/。
  // 只使用有效的 TikTok 链接；历史数据缺失或不合法时，回退到可重定向的官方 PDP 地址。
  const detailUrl = p.detail_url?.trim();
  const url = detailUrl && /^https:\/\/(?:www\.|shop\.)?tiktok\.com\//i.test(detailUrl)
    ? detailUrl
    : `https://www.tiktok.com/shop/pdp/${encodeURIComponent(p.external_product_id)}`;
  await browser.tabs.create({ url });
}

/** 打开商品图片大图预览。 */
function openImagePreview(imageUrl?: string | null): void {
  previewImageUrl.value = imageUrl?.trim() || null;
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
    const closed = r.closed_batch_ids?.length
      ? `（已结束残留批次 ${r.closed_batch_ids.join('、')}）`
      : '';
    feedback.value = `已创建并开始采集：${r.batch_id}${closed}（单商品，强制重抓）。可在「任务」页查看进度。`;
  } catch (e) {
    errorText.value = classifyError(e).text;
  } finally {
    collectingKey.value = null;
  }
}

/**
 * 导出 CSV：按当前过滤条件分页拉取记录（最多 500 条）
 * 数据源与服务端一致：管理员导出全量商品，普通账号导出自己的商品。
 */
async function exportCsv(): Promise<void> {
  errorText.value = null;
  try {
    const rows: ProductItem[] = [];
    for (let p = 1; p <= 5; p++) {
      const payload = buildPayload(p, 100);
      const r = isAdmin.value
        ? await sendMsg('admin.listProducts', payload)
        : await sendMsg('product.list', payload);
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
    const prefix = isAdmin.value ? 'admin-products' : 'my-products';
    downloadText(`${prefix}-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    feedback.value = isAdmin.value
      ? `已导出 ${rows.length} 条全量商品记录（当前过滤条件，单次上限 500 条）。`
      : `已导出 ${rows.length} 条我的商品记录（当前过滤条件，单次上限 500 条）。`;
  } catch (e) {
    errorText.value = classifyError(e).text;
  }
}

watch([page, perPage, sort, order], () => void load());

// 隐藏设置切换管理员模式后，重置到第一页并同时刷新批次下拉与商品数据源
watch(isAdmin, () => {
  page.value = 1;
  void load();
});

/**
 * 把 URL query 中的跳转上下文写入过滤条件
 * 支持从「任务」页批次跳转（batch_id/region/variant）与从「榜单采集」快照跳转（snapshot_id/日期）
 */
function applyRouteQuery(): void {
  const sd = route.query.snapshot_date;
  if (typeof sd === 'string' && sd) {
    filter.value.date_from = sd;
    filter.value.date_to = sd;
  } else {
    filter.value.date_from = '';
    filter.value.date_to = '';
  }
  const qs = route.query.snapshot_id;
  filter.value.snapshot_id = typeof qs === 'string' ? qs : '';
  const qb = route.query.batch_id;
  filter.value.batch_id = typeof qb === 'string' ? qb : '';
  const qr = route.query.region;
  filter.value.region = typeof qr === 'string' ? qr : '';
  const qv = route.query.variant;
  filter.value.ranking_variant = typeof qv === 'string' ? qv : '';
  const qsp = route.query.source_platform;
  filter.value.source_platform = typeof qsp === 'string' ? qsp : '';
}

// 路由变化（含重复跳转到同一路径）时也要重新应用过滤条件，避免筛选条件"丢失"
watch(
  () => route.fullPath,
  () => {
    if (route.path !== '/products') return;
    applyRouteQuery();
    page.value = 1;
    void load();
  },
);

onMounted(async () => {
  applyRouteQuery();
  await loadSources();
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
    <div class="card product-filters">
      <!-- 跳转带入的筛选：显式展示，避免看起来"没过滤" -->
      <div v-if="activeJumpFilters.length" class="form-row" style="align-items:center">
        <label>当前筛选</label>
        <span
          v-for="t in activeJumpFilters"
          :key="t.key"
          class="badge info"
          style="margin-right: 6px"
        >{{ t.text }}</span>
        <button class="link" @click="clearJumpFilter(activeJumpFilters[0]!.key)">清除</button>
      </div>
      <div class="product-filter-grid">
        <label>关键词
          <input v-model="filter.keyword" placeholder="商品名称、商品 ID、店铺" @keyup.enter="applyFilter" />
        </label>
        <label>来源渠道
          <select v-model="filter.source_platform" @change="applyFilter">
            <option value="">全部</option>
            <option v-for="s in sources" :key="s.id" :value="s.id">{{ s.label }}</option>
          </select>
        </label>
        <label>站点
          <input v-model="filter.region" placeholder="如 US、MX" @keyup.enter="applyFilter" @change="applyFilter" />
        </label>
        <label>排序
          <select v-model="sort">
            <option v-for="o in SORT_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </label>
        <label>顺序
          <select v-model="order">
            <option value="desc">降序</option>
            <option value="asc">升序</option>
          </select>
        </label>
        <button class="act product-filter-submit" @click="applyFilter">查询</button>
      </div>
      <div class="product-date-filter">
        <span>采集时间</span>
        <input v-model="filter.date_from" type="date" aria-label="采集开始日期" @change="applyFilter" />
        <span class="muted">至</span>
        <input v-model="filter.date_to" type="date" aria-label="采集结束日期" @change="applyFilter" />
      </div>
    </div>

    <!-- 商品表格 -->
    <div class="card" style="padding: 8px">
      <div v-if="loading" class="muted small" style="padding: 12px">加载中…</div>
      <div v-else-if="!data || !data.items.length" class="empty">
        <template v-if="isAdmin">暂无匹配数据。</template>
        <template v-else-if="filter.batch_id">
          该批次没有匹配的商品：可能该批次来自其他账号，或尚未采集。
        </template>
        <template v-else>
          暂无商品记录。请先在「榜单采集」页抓取榜单。
        </template>
      </div>
      <template v-else>
        <table class="list">
          <thead>
            <tr>
              <th>图</th><th>商品</th><th v-if="!isAdmin">来源</th><th>站点</th><th>店铺</th><th>类目</th><th>排名</th><th>{{ isAdmin ? '最近出现' : '采集时间' }}</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in data.items" :key="p.id">
              <td>
                <button
                  v-if="p.image_url"
                  class="image-preview-trigger"
                  type="button"
                  :aria-label="`预览${p.title || '商品'}图片`"
                  @click="openImagePreview(p.image_url)"
                ><img :src="p.image_url" class="thumb" :alt="p.title || '商品图片'" /></button>
                <span v-else class="muted">—</span>
              </td>
              <td>
                <div>{{ p.title ?? '—' }}</div>
                <div class="mono muted">{{ p.external_product_id }}</div>
              </td>
              <td v-if="!isAdmin" class="small"><span class="badge info">{{ sourceLabel(p.source_platform) }}</span></td>
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

    <!-- 商品图片大图预览 -->
    <div v-if="previewImageUrl" class="image-preview-mask" role="dialog" aria-modal="true" aria-label="商品图片预览" @click.self="previewImageUrl = null">
      <div class="image-preview-box">
        <button class="image-preview-close" type="button" aria-label="关闭图片预览" @click="previewImageUrl = null">×</button>
        <img :src="previewImageUrl" alt="商品大图" />
      </div>
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
