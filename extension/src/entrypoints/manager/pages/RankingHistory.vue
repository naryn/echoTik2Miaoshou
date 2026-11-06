<script setup lang="ts">
/** 历史榜单：独立展示服务端快照，服务端按最新 capture_started_at 倒序返回。 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { sendMsg } from '@/shared/messaging';
import type { CategoryNode, RankingQuery, RankingSource, SnapshotSummary } from '@/shared/types';
import { classifyError, formatTime, statusBadgeClass, statusText, uuid } from '../utils';

const router = useRouter();
const sources = ref<{ id: string; label: string }[]>([]);
const snapshots = ref<SnapshotSummary[]>([]);
const total = ref(0);
const loading = ref(false);
const errorText = ref<string | null>(null);
const feedback = ref<string | null>(null);
const filter = ref({ status: '', source_platform: '', date_from: '', date_to: '' });
const categories = ref<CategoryNode[]>([]);
/** 历史快照服务端分页状态。 */
const page = ref(1);
const perPage = ref(20);
/** 勾选的快照可跨分页保留，用于合并为一个连续执行的 ERP 批次。 */
const selectedSnapshotIds = ref<string[]>([]);
const batchCreating = ref(false);
const allCurrentPageSelected = computed(
  () => snapshots.value.length > 0 && snapshots.value.every((snapshot) => selectedSnapshotIds.value.includes(snapshot.snapshot_id)),
);

const VARIANT_LABELS: Record<string, string> = {
  'top-sold': '热销榜', 'hot-sell': '热推榜', 'news-burst': '新品榜', products: '商品库',
};
const FASTMOSS_VARIANT_LABELS: Record<string, string> = {
  'top-sold': '销量榜', 'hot-sell': '热推榜', 'news-burst': '新品榜', products: '商品库',
};

function sourceLabel(source?: string | null): string {
  const id = source ?? 'ECHOTIK';
  return sources.value.find((s) => s.id === id)?.label ?? (id === 'FASTMOSS' ? 'FastMoss' : 'EchoTik');
}

function variantLabel(value?: string | null, source?: string | null): string {
  if (!value) return '—';
  return source === 'FASTMOSS' ? (FASTMOSS_VARIANT_LABELS[value] ?? value) : (VARIANT_LABELS[value] ?? value);
}

/** 将任意层级分类 ID 映射为其所属一级分类名称。 */
function topCategoryLabel(categoryId?: string | null, source?: string | null): string {
  if (!categoryId) return '全部分类';
  if (source === 'FASTMOSS') return `分类 ${categoryId}`;
  for (const top of categories.value) {
    if (top.value === categoryId) return top.label;
    const stack = [...(top.children ?? [])];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.value === categoryId) return top.label;
      stack.push(...(node.children ?? []));
    }
  }
  return `分类 ${categoryId}`;
}

async function load(): Promise<void> {
  loading.value = true;
  errorText.value = null;
  try {
    const r = await sendMsg('snapshot.list', {
      status: filter.value.status || undefined,
      source_platform: filter.value.source_platform || undefined,
      date_from: filter.value.date_from ? new Date(filter.value.date_from).toISOString() : undefined,
      date_to: filter.value.date_to ? new Date(filter.value.date_to + 'T23:59:59').toISOString() : undefined,
      page: page.value,
      per_page: perPage.value,
    });
    snapshots.value = r.items;
    total.value = r.total;
  } catch (e) {
    errorText.value = classifyError(e).text;
  } finally {
    loading.value = false;
  }
}

/** 应用筛选时始终从第一页重新查询。 */
function applyFilter(): void {
  page.value = 1;
  void load();
}

/** 更改每页数量时回到第一页，避免保留无效页码。 */
function changePerPage(): void {
  page.value = 1;
  void load();
}

/** 按浏览器本地日历将采集日期快速限定为今天。 */
function filterToday(): void {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const today = `${now.getFullYear()}-${month}-${day}`;
  filter.value.date_from = today;
  filter.value.date_to = today;
  applyFilter();
}

function viewProducts(s: SnapshotSummary): void {
  const query: Record<string, string> = { snapshot_id: s.snapshot_id };
  if (s.region) query.region = s.region;
  if (s.ranking_variant) query.variant = s.ranking_variant;
  if (s.source_platform) query.source_platform = s.source_platform;
  router.push({ path: '/products', query });
}

async function createBatch(s: SnapshotSummary): Promise<void> {
  try {
    const batch = await sendMsg('batch.create', {
      snapshot_id: s.snapshot_id,
      exclude_already_successful: false,
      idempotency_key: uuid(),
    });
    feedback.value = `已创建 ERP 批次 ${batch.batch_id.slice(0, 8)}（${batch.summary?.total ?? '—'} 件）。`;
  } catch (e) {
    errorText.value = classifyError(e).text;
  }
}

/** 选中/取消选中当前页全部快照。 */
function toggleCurrentPageSnapshots(): void {
  const currentIds = snapshots.value.map((snapshot) => snapshot.snapshot_id);
  selectedSnapshotIds.value = allCurrentPageSelected.value
    ? selectedSnapshotIds.value.filter((id) => !currentIds.includes(id))
    : [...new Set([...selectedSnapshotIds.value, ...currentIds])];
}

/**
 * 将多个快照中的商品去重后合并为一个批次并立即启动。
 * 服务端当前一个批次只关联一个 source_snapshot_id，故在客户端先按快照拉取商品 ID，
 * 再使用 product_ids 创建单个连续执行队列。
 */
async function createAndRunBatchFromSelected(): Promise<void> {
  if (!selectedSnapshotIds.value.length || batchCreating.value) return;
  batchCreating.value = true;
  errorText.value = null;
  feedback.value = null;
  try {
    const productIds = new Set<string>();
    for (const snapshotId of selectedSnapshotIds.value) {
      let snapshotPage = 1;
      let snapshotTotal = 0;
      do {
        const result = await sendMsg('product.list', {
          snapshot_id: snapshotId,
          sort: 'rank_position',
          order: 'asc',
          page: snapshotPage,
          per_page: 100,
        });
        result.items.forEach((product) => productIds.add(product.id));
        snapshotTotal = result.total;
        snapshotPage += 1;
      } while ((snapshotPage - 1) * 100 < snapshotTotal);
    }
    if (!productIds.size) throw new Error('所选快照没有可创建任务的商品');

    const batch = await sendMsg('batch.create', {
      product_ids: [...productIds],
      exclude_already_successful: false,
      idempotency_key: uuid(),
    });
    await sendMsg('runner.start', { batchId: batch.batch_id });
    feedback.value = `已将 ${selectedSnapshotIds.value.length} 个快照的 ${productIds.size} 件商品合并为批次 ${batch.batch_id.slice(0, 8)}，并开始执行。`;
    selectedSnapshotIds.value = [];
    router.push('/tasks');
  } catch (e) {
    errorText.value = classifyError(e).text;
  } finally {
    batchCreating.value = false;
  }
}

async function recollect(s: SnapshotSummary): Promise<void> {
  const fj = (s.filter_json ?? {}) as Record<string, unknown>;
  const query: RankingQuery = {
    source: (s.source_platform as RankingSource) ?? 'ECHOTIK', region: s.region ?? 'MX',
    categoryId: s.category_id ?? undefined, rankingType: s.ranking_type ?? 'daily',
    rankingVariant: s.ranking_variant ?? 'top-sold', periodStart: s.period_start ?? undefined,
    periodEnd: s.period_end ?? undefined, dateRange: (fj.dateRange as number) ?? undefined,
    sortBy: (fj.sortBy as string) ?? undefined, startRank: (fj.startRank as number) ?? 1,
    limit: (fj.limit as number) ?? 100,
  };
  try {
    await sendMsg('ranking.startCollect', { query });
    router.push('/ranking');
  } catch (e) {
    errorText.value = classifyError(e).text;
  }
}

onMounted(async () => {
  sources.value = await sendMsg('ranking.sources', undefined).then((r) => r.items.map((s) => ({ id: s.id, label: s.label }))).catch(() => []);
  categories.value = await sendMsg('echotik.getCategories', undefined).then((r) => r.items).catch(() => []);
  await load();
});
</script>

<template>
  <div>
    <div v-if="errorText" class="alert-bar err">{{ errorText }}</div>
    <div v-if="feedback" class="alert-bar" style="background:#f0fdf4;border-color:#bbf7d0;color:#166534">{{ feedback }}</div>
    <div class="card">
      <h3>
        历史榜单
        <span class="muted small">共 {{ total }} 个快照，按最新采集时间排序 · EchoTik：采集经页面同源接口，需保持榜单页登录态。</span>
      </h3>
      <div class="form-row">
        <label>数据来源</label>
        <select v-model="filter.source_platform" @change="applyFilter"><option value="">全部</option><option v-for="s in sources" :key="s.id" :value="s.id">{{ s.label }}</option></select>
        <label style="width:auto">状态</label>
        <select v-model="filter.status" @change="applyFilter"><option value="">全部</option><option value="COMPLETED">完成</option><option value="PARTIAL">部分完成</option><option value="FAILED">失败</option></select>
      </div>
      <div class="form-row">
        <label>采集日期</label><input v-model="filter.date_from" type="date" @change="applyFilter" /><span class="muted">至</span><input v-model="filter.date_to" type="date" @change="applyFilter" />
        <button class="act" @click="filterToday">今天</button>
        <button class="act" :disabled="loading" @click="load">{{ loading ? '加载中…' : '刷新列表' }}</button>
      </div>
    </div>
    <div v-if="loading" class="muted small">加载中…</div>
    <div v-else-if="!snapshots.length" class="empty">暂无历史快照。请在「榜单采集」完成一次抓取。</div>
    <div v-else class="card" style="padding:8px">
      <div class="snapshot-batch-toolbar">
        <span class="muted small">已选 {{ selectedSnapshotIds.length }} 个快照；同一商品会自动去重。</span>
        <button
          class="primary"
          :disabled="!selectedSnapshotIds.length || batchCreating"
          @click="createAndRunBatchFromSelected"
        >{{ batchCreating ? '正在创建并启动…' : `创建并执行已勾选快照（${selectedSnapshotIds.length}）` }}</button>
      </div>
      <table class="list">
        <thead><tr>
          <th class="snapshot-check"><input type="checkbox" :checked="allCurrentPageSelected" aria-label="勾选当前页全部快照" @change="toggleCurrentPageSnapshots" /></th>
          <th>快照</th><th>站点</th><th>榜单/周期</th><th>一级分类</th><th>行数</th><th>采集时间</th><th>状态</th><th>操作</th>
        </tr></thead>
        <tbody><tr v-for="s in snapshots" :key="s.snapshot_id">
          <td class="snapshot-check"><input v-model="selectedSnapshotIds" type="checkbox" :value="s.snapshot_id" :aria-label="`选择快照 ${s.snapshot_id}`" /></td>
          <td class="mono">{{ s.snapshot_id.slice(0, 8) }}<div class="small"><span class="badge info">{{ sourceLabel(s.source_platform) }}</span></div></td>
          <td>{{ s.region ?? '—' }}</td>
          <td class="small">{{ variantLabel(s.ranking_variant, s.source_platform) }}<template v-if="s.ranking_variant !== 'products'"> / {{ s.ranking_type ?? '—' }}</template><div class="muted">{{ s.period_start ?? '—' }}</div></td>
          <td class="small">{{ topCategoryLabel(s.category_id, s.source_platform) }}</td>
          <td>{{ s.total_entries ?? '—' }}</td><td class="small">{{ formatTime(s.capture_started_at) }}</td>
          <td><span :class="statusBadgeClass(s.status)">{{ statusText(s.status) }}</span></td>
          <td><button class="link" @click="viewProducts(s)">查看商品</button><button class="link" @click="recollect(s)">重新获取</button><button class="link" @click="createBatch(s)">创建 ERP 批次</button></td>
        </tr></tbody>
      </table>
      <div class="pager">
        <button class="act" :disabled="loading || page <= 1" @click="page--; load()">上一页</button>
        <span>第 {{ page }} 页 / 共 {{ Math.max(1, Math.ceil(total / perPage)) }} 页（{{ total }} 个快照）</span>
        <button class="act" :disabled="loading || page * perPage >= total" @click="page++; load()">下一页</button>
        <select v-model.number="perPage" :disabled="loading" @change="changePerPage">
          <option :value="20">20/页</option>
          <option :value="50">50/页</option>
          <option :value="100">100/页</option>
        </select>
      </div>
    </div>
  </div>
</template>
