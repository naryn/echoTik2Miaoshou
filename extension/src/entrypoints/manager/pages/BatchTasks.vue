<script setup lang="ts">
/**
 * 批次任务页 BatchTasks（规范 §3.5）：批次列表 + 批次详情两层。
 * - 列表：批次号/来源快照/创建时间/总数/进度/成功/跳过/失败/不确定/客户端/状态/起止时间，日期+状态筛选
 * - 详情：状态卡、开始/暂停/继续/停止/失败重试（按 §8.2 状态机启用禁用）、进度条、任务子表、
 *   结果过滤、单任务侧滑抽屉、采集尝试时间线
 * - 运行前检查（登录态/TikTok Tab/妙手/远程），不通过时显示具体错误与"重新检测"
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { sendMsg } from '@/shared/messaging';
import type { AttemptItem, BatchItem, ClientMe, Paginated, TaskItem } from '@/shared/types';
import { BATCH_STATUSES } from '@/shared/types';
import type { MessageMap } from '@/shared/types/messages';
import { refreshState, store } from '../store';
import { classifyError, formatTime, statusBadgeClass, statusText, taskStatusText, uuid } from '../utils';

/** 批次状态文案选项 */
const BATCH_STATUS_OPTIONS = BATCH_STATUSES.map((s) => ({ value: s, label: statusText(s) }));

const router = useRouter();

/**
 * 查看该批次的商品：跳到商品列表并带上批次过滤条件（含站点/榜单，便于识别）
 * @param b 批次
 */
function viewBatchProducts(b: BatchItem): void {
  const query: Record<string, string> = { batch_id: b.batch_id };
  if (b.snapshot?.snapshot_id) query.snapshot_id = b.snapshot.snapshot_id;
  if (b.snapshot?.region) query.region = b.snapshot.region;
  if (b.snapshot?.ranking_variant) query.variant = b.snapshot.ranking_variant;
  const source = b.source_platform ?? b.snapshot?.source_platform;
  if (source) query.source_platform = source;
  router.push({ path: '/products', query });
}

/** 来源平台选项（来自 background 注册表，便于后续扩展） */
const sources = ref<{ id: string; label: string }[]>([]);

/**
 * 来源平台展示名（缺省视为 EchoTik）
 * @param p 平台标识
 */
function sourceLabel(p?: string | null): string {
  const id = p ?? 'ECHOTIK';
  return sources.value.find((s) => s.id === id)?.label ?? id;
}

// ---------------- 批次列表 ----------------

/** 是否管理员角色（auth_users.role=ADMIN 时读取全部账号数据，只读） */
const isAdmin = computed(() => store.state?.role === 'ADMIN');
/** 管理员：全量客户端（用于归属筛选与展示） */
const adminClients = ref<ClientMe[]>([]);
/** 管理员：客户端筛选 */
const adminClientFilter = ref('');

/** 列表筛选 */
const listFilter = ref({ status: '', date_from: '', date_to: '', region: '' });
const batches = ref<Paginated<BatchItem> | null>(null);
const listLoading = ref(false);
const listPage = ref(1);
const errorText = ref<string | null>(null);
const feedback = ref<string | null>(null);

/** 当前选中批次（详情层） */
const detail = ref<BatchItem | null>(null);
/** 任务子表 */
const tasks = ref<Paginated<TaskItem> | null>(null);
const taskPage = ref(1);
const taskStatus = ref('');
/** 任务抽屉 */
const taskDrawer = ref<TaskItem | null>(null);
/** 采集尝试时间线（批次详情） */
const attempts = ref<AttemptItem[]>([]);
/** 运行前检查结果 */
const precheck = ref<MessageMap['env.check']['res'] | null>(null);
const precheckErrors = ref<string[]>([]);
const acting = ref(false);

/** 批次进度（已处理/总数） */
function batchProgress(b: BatchItem): { done: number; total: number } {
  const s = b.summary ?? {};
  const done = (s.success ?? 0) + (s.failed ?? 0) + (s.skipped ?? 0) + (s.unknown ?? 0);
  return { done, total: s.total ?? done };
}

/** 列表中本页站点筛选（服务端不支持批次按站点过滤） */
const visibleBatches = computed(() => {
  const items = batches.value?.items ?? [];
  if (!listFilter.value.region) return items;
  return items.filter((b) => (b.config_json?.region as string) === listFilter.value.region);
});

/**
 * 客户端展示名（管理员跨客户端视图使用，缺失时回退到 client_id 前 8 位）
 * @param id 客户端 ID
 */
function clientLabel(id?: string | null): string {
  if (!id) return '—';
  const hit = adminClients.value.find((c) => c.client_id === id);
  return hit?.display_name || id.slice(0, 8);
}

/**
 * 加载管理员可见的全量客户端列表（仅管理员模式）
 */
async function loadAdminClients(): Promise<void> {
  if (!isAdmin.value) return;
  try {
    const r = await sendMsg('admin.listClients', undefined);
    adminClients.value = r.items;
  } catch {
    adminClients.value = [];
  }
}

/**
 * 加载批次列表
 * 普通模式：仅本客户端批次；管理员模式：远端全量批次（可按客户端筛选）
 */
async function loadBatches(): Promise<void> {
  listLoading.value = true;
  errorText.value = null;
  try {
    const payload = {
      status: listFilter.value.status || undefined,
      date_from: listFilter.value.date_from ? new Date(listFilter.value.date_from).toISOString() : undefined,
      date_to: listFilter.value.date_to ? new Date(listFilter.value.date_to + 'T23:59:59').toISOString() : undefined,
      page: listPage.value,
      per_page: 20,
    };
    batches.value = isAdmin.value
      ? await sendMsg('admin.listBatches', {
          ...payload,
          client_id: adminClientFilter.value || undefined,
        })
      : await sendMsg('batch.list', payload);
  } catch (e) {
    errorText.value = classifyError(e).text;
  } finally {
    listLoading.value = false;
  }
}

/**
 * 打开批次详情
 * @param b 批次
 */
async function openDetail(b: BatchItem): Promise<void> {
  detail.value = null;
  taskPage.value = 1;
  taskStatus.value = '';
  try {
    detail.value = isAdmin.value
      ? await sendMsg('admin.getBatch', { batch_id: b.batch_id })
      : await sendMsg('batch.get', { batch_id: b.batch_id });
    await Promise.all([loadTasks(), loadAttempts()]);
  } catch (e) {
    errorText.value = classifyError(e).text;
  }
}

/**
 * 返回列表层并刷新
 */
async function backToList(): Promise<void> {
  detail.value = null;
  taskDrawer.value = null;
  await loadBatches();
}

/**
 * 加载任务子表
 * 管理员模式下走管理端接口（可读取任意客户端批次）
 */
async function loadTasks(): Promise<void> {
  if (!detail.value) return;
  try {
    const params = {
      batch_id: detail.value.batch_id,
      status: taskStatus.value || undefined,
      page: taskPage.value,
      per_page: 20,
    };
    tasks.value = isAdmin.value
      ? await sendMsg('admin.batchTasks', params)
      : await sendMsg('batch.tasks', params);
  } catch (e) {
    errorText.value = classifyError(e).text;
  }
}

/**
 * 加载批次采集尝试（作为错误与恢复事件时间线）
 */
async function loadAttempts(): Promise<void> {
  if (!detail.value) return;
  try {
    const r = await sendMsg('attempt.list', { batch_id: detail.value.batch_id, per_page: 50 });
    attempts.value = r.items;
  } catch {
    attempts.value = [];
  }
}

/**
 * 运行前检查：EchoTik 登录 / TikTok Tab / 妙手 / 远程连通
 * @returns 是否全部通过
 */
async function runPrecheck(): Promise<boolean> {
  precheckErrors.value = [];
  try {
    precheck.value = await sendMsg('env.check', undefined);
  } catch (e) {
    precheckErrors.value = [classifyError(e).text];
    return false;
  }
  const e = precheck.value;
  if (!e.server.connected) precheckErrors.value.push('远程服务器不可达');
  if (!e.echotik.tab_found) precheckErrors.value.push('未找到 EchoTik 页面');
  if (e.echotik.logged_in === false) precheckErrors.value.push('EchoTik 未登录');
  if (e.miaoshou.checked && e.miaoshou.available === false) precheckErrors.value.push('妙手按钮未检测到（TikTok 工作页）');
  return precheckErrors.value.length === 0;
}

/**
 * 批次动作（开始/暂停/继续/停止/失败重试），反馈以真实服务端响应为准
 * @param action 动作
 */
async function batchAction(action: 'start' | 'pause' | 'resume' | 'cancel' | 'retryFailed'): Promise<void> {
  if (isAdmin.value || !detail.value || acting.value) return;
  errorText.value = null;
  feedback.value = null;
  // 开始前做运行前检查
  if (action === 'start' || action === 'resume') {
    const okRun = await runPrecheck();
    if (!okRun) return; // 展示具体错误，由用户点击"重新检测"
  }
  acting.value = true;
  try {
    const id = detail.value.batch_id;
    let updated: BatchItem;
    if (action === 'start') updated = await sendMsg('batch.start', { batch_id: id });
    else if (action === 'pause') updated = await sendMsg('batch.pause', { batch_id: id });
    else if (action === 'resume') updated = await sendMsg('batch.resume', { batch_id: id });
    else if (action === 'cancel') updated = await sendMsg('batch.cancel', { batch_id: id });
    else {
      updated = await sendMsg('batch.retryFailed', { batch_id: id, idempotency_key: uuid() });
      feedback.value = `补采批次已创建：${updated.batch_id.slice(0, 8)}（仅含失败任务，关联原批次）。`;
      detail.value = updated;
      await refreshState();
      return;
    }
    detail.value = updated;
    await refreshState();
    await loadTasks();
  } catch (e) {
    errorText.value = classifyError(e).text;
  } finally {
    acting.value = false;
  }
}

/**
 * 单条重新抓取：服务端重置为待抓取并跳过去重，本客户端随后领取并打开详情页
 * @param t 目标任务
 */
async function recollectTask(t: TaskItem): Promise<void> {
  if (isAdmin.value || acting.value) return;
  errorText.value = null;
  feedback.value = null;
  acting.value = true;
  try {
    await sendMsg('batch.recollectTask', { task_id: t.task_id });
    feedback.value = '已重置为待抓取，正在领取并打开 TikTok 详情页…';
    await refreshState();
    await loadTasks();
    if (detail.value?.batch_id === t.batch_id) {
      detail.value = await sendMsg('batch.get', { batch_id: t.batch_id });
    }
    taskDrawer.value = null;
  } catch (e) {
    errorText.value = classifyError(e).text;
  } finally {
    acting.value = false;
  }
}

/** 榜单变体/榜单类型中文名 */
const VARIANT_LABELS: Record<string, string> = { 'top-sold': '热销榜', 'hot-sell': '热推榜', 'news-burst': '新品榜', products: '商品库' };
const TYPE_LABELS: Record<string, string> = { daily: '日榜', weekly: '周榜', monthly: '月榜' };

/**
 * 来源榜单条件展示：站点、榜单、类型、类目、榜单日期、快照条数
 * 快照缺失（按商品 ID 手工建批）时返回 null
 */
const snapshotInfo = computed(() => {
  const s = detail.value?.snapshot;
  if (!s) return null;
  const fmt = (v?: string | null): string => {
    if (!v) return '—';
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : v;
  };
  const period = s.period_start
    ? `${fmt(s.period_start)}${s.period_end ? ` ~ ${fmt(s.period_end)}` : ''}`
    : '—';
  return {
    source: sourceLabel(detail.value?.source_platform ?? s.source_platform),
    region: (s.region ?? '—').toUpperCase(),
    variant: VARIANT_LABELS[s.ranking_variant ?? ''] ?? s.ranking_variant ?? '—',
    type: TYPE_LABELS[s.ranking_type ?? ''] ?? s.ranking_type ?? '—',
    category: s.category_id ?? '全部',
    period,
    total: s.total_entries ?? 0,
  };
});

const canStart = computed(() => !!detail.value && ['DRAFT', 'READY', 'PAUSED', 'CANCELLED'].includes(detail.value.status));
const canPause = computed(() => detail.value?.status === 'RUNNING');
const canResume = computed(() => detail.value?.status === 'PAUSED');
const canCancel = computed(() => !!detail.value && !['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED'].includes(detail.value.status));
const canRetryFailed = computed(() => (detail.value?.summary?.failed ?? 0) > 0);

/** 任务状态筛选选项 */
const TASK_FILTER_OPTIONS = [
  '', 'PENDING', 'LEASED', 'NAVIGATING', 'PAGE_READY', 'SUBMITTING', 'SUBMITTED',
  'SUCCESS', 'SKIPPED', 'FAILED', 'UNKNOWN', 'WAITING_VERIFICATION',
];

onMounted(async () => {
  await sendMsg('ranking.sources', undefined)
    .then((r) => {
      sources.value = r.items.map((s) => ({ id: s.id, label: s.label }));
    })
    .catch(() => undefined);
  await loadAdminClients();
  await loadBatches();
});

// 隐藏设置切换管理员模式后，重置到列表层并按新数据源重新加载
watch(isAdmin, async () => {
  detail.value = null;
  taskDrawer.value = null;
  attempts.value = [];
  listPage.value = 1;
  adminClientFilter.value = '';
  await loadAdminClients();
  await loadBatches();
});
</script>

<template>
  <div>
    <div v-if="errorText" class="alert-bar err">{{ errorText }}</div>
    <div v-if="feedback" class="alert-bar" style="background:#f0fdf4;border-color:#bbf7d0;color:#166534">{{ feedback }}</div>

    <!-- ============ 批次列表层 ============ -->
    <template v-if="!detail">
      <div v-if="isAdmin" class="alert-bar" style="background:#eff6ff;border-color:#bfdbfe;color:#1e40af">
        超级管理员只读视图：展示所有账号的抓取批次（不可控制执行）。
      </div>
      <div class="card">
        <div class="form-row">
          <label>状态</label>
          <select v-model="listFilter.status" @change="((listPage = 1), loadBatches())">
            <option value="">全部</option>
            <option v-for="o in BATCH_STATUS_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>
        <div class="form-row">
          <label>创建日期</label>
          <input v-model="listFilter.date_from" type="date" @change="((listPage = 1), loadBatches())" />
          <input v-model="listFilter.date_to" type="date" @change="((listPage = 1), loadBatches())" />
        </div>
        <div v-if="isAdmin" class="form-row">
          <label>客户端</label>
          <select v-model="adminClientFilter" @change="((listPage = 1), loadBatches())">
            <option value="">全部客户端</option>
            <option v-for="c in adminClients" :key="c.client_id" :value="c.client_id">
              {{ c.display_name || c.client_id.slice(0, 8) }}
            </option>
          </select>
        </div>
        <div class="form-row">
          <label>站点</label>
          <select v-model="listFilter.region">
            <option value="">全部</option>
            <option v-for="r in ['US', 'UK', 'ID', 'MY', 'TH', 'VN', 'PH', 'SG']" :key="r" :value="r">{{ r }}</option>
          </select>
          <span class="muted small">（仅本页内筛选）</span>
        </div>
      </div>

      <div v-if="listLoading" class="muted small">加载中…</div>
      <div v-else-if="!visibleBatches.length" class="empty">
        暂无批次。可在「榜单采集」从历史快照创建 ERP 批次，或在「商品列表」勾选商品创建。
      </div>
      <div v-else class="card" style="padding: 8px">
        <table class="list">
          <thead>
            <tr>
              <th>批次号</th><th v-if="isAdmin">客户端</th><th>创建时间</th><th>进度</th><th>结果</th><th>状态</th><th>起止</th><th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in visibleBatches" :key="b.batch_id">
              <td>
                <div class="mono">{{ b.batch_id.slice(0, 8) }}</div>
                <div class="small"><span class="badge info">{{ sourceLabel(b.source_platform ?? b.snapshot?.source_platform) }}</span></div>
                <div class="muted small mono" v-if="b.source_snapshot_id">快照 {{ b.source_snapshot_id.slice(0, 8) }}</div>
                <div class="muted small mono" v-if="b.parent_batch_id">补采自 {{ b.parent_batch_id.slice(0, 8) }}</div>
              </td>
              <td v-if="isAdmin" class="small">
                {{ clientLabel(b.client_id) }}
                <div class="muted mono">{{ b.client_id?.slice(0, 8) ?? '—' }}</div>
              </td>
              <td class="small">{{ formatTime(b.created_at) }}</td>
              <td class="small">{{ batchProgress(b).done }}/{{ batchProgress(b).total || '—' }}</td>
              <td class="small">
                成 {{ b.summary?.success ?? 0 }} 跳 {{ b.summary?.skipped ?? 0 }}<br />
                败 {{ b.summary?.failed ?? 0 }} 未 {{ b.summary?.unknown ?? 0 }}
              </td>
              <td><span :class="statusBadgeClass(b.status)">{{ statusText(b.status) }}</span></td>
              <td class="small muted">{{ formatTime(b.started_at) }}<br />{{ formatTime(b.finished_at) }}</td>
              <td>
                <button class="link" @click="openDetail(b)">详情</button>
                <button class="link" @click="viewBatchProducts(b)">商品</button>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="pager" v-if="batches">
          <button class="act" :disabled="listPage <= 1" @click="((listPage--), loadBatches())">上一页</button>
          <span>第 {{ batches.page }} 页 / 共 {{ batches.total }} 批</span>
          <button class="act" :disabled="listPage * 20 >= batches.total" @click="((listPage++), loadBatches())">下一页</button>
        </div>
      </div>
    </template>

    <!-- ============ 批次详情层 ============ -->
    <template v-else>
      <div class="card">
        <div class="btn-row" style="margin-top: 0; margin-bottom: 8px">
          <button class="act" @click="backToList">← 返回列表</button>
        </div>
        <h3>
          批次 <span class="mono">{{ detail.batch_id.slice(0, 8) }}</span>
          <span class="badge info">{{ sourceLabel(detail.source_platform ?? detail.snapshot?.source_platform) }}</span>
          <span :class="statusBadgeClass(detail.status)">{{ statusText(detail.status) }}</span>
          <span v-if="store.state?.active_batch_id === detail.batch_id" class="badge info">本客户端执行中</span>
          <span v-if="isAdmin" class="badge info">管理员只读 · {{ clientLabel(detail.client_id) }}</span>
        </h3>
        <div class="small muted">
          创建 {{ formatTime(detail.created_at) }} · 开始 {{ formatTime(detail.started_at) }} · 结束 {{ formatTime(detail.finished_at) }}
          <template v-if="detail.source_snapshot_id"> · 来源快照 <span class="mono">{{ detail.source_snapshot_id.slice(0, 8) }}</span></template>
          <template v-if="detail.parent_batch_id"> · 补采自 <span class="mono">{{ detail.parent_batch_id.slice(0, 8) }}</span></template>
        </div>
        <!-- 来源榜单信息：站点/榜单/类型/类目/日期/条数 -->
        <div v-if="snapshotInfo" class="small" style="margin-top: 4px">
          来源 {{ snapshotInfo.source }} · 榜单 {{ snapshotInfo.region }} · {{ snapshotInfo.variant }} · {{ snapshotInfo.type }} ·
          类目 {{ snapshotInfo.category }} · 日期 {{ snapshotInfo.period }} · 快照 {{ snapshotInfo.total }} 条
        </div>
        <div class="progress" style="margin: 8px 0">
          <div :style="{ width: (batchProgress(detail).total ? Math.round((batchProgress(detail).done / batchProgress(detail).total) * 100) : 0) + '%' }"></div>
        </div>
        <div class="small">
          进度 {{ batchProgress(detail).done }}/{{ batchProgress(detail).total || '—' }} ·
          成功 {{ detail.summary?.success ?? 0 }} · 跳过 {{ detail.summary?.skipped ?? 0 }} ·
          失败 {{ detail.summary?.failed ?? 0 }} · 不确定 {{ detail.summary?.unknown ?? 0 }}
        </div>
        <div class="btn-row" style="flex-wrap: wrap">
          <template v-if="!isAdmin">
            <button class="primary" :disabled="!canStart || acting" @click="batchAction('start')">{{ detail.status === 'CANCELLED' ? '重新开始' : '开始' }}</button>
            <button class="act" :disabled="!canPause || acting" @click="batchAction('pause')">暂停</button>
            <button class="act" :disabled="!canResume || acting" @click="batchAction('resume')">继续</button>
            <button class="act danger" :disabled="!canCancel || acting" @click="batchAction('cancel')">停止</button>
            <button class="act" :disabled="!canRetryFailed || acting" @click="batchAction('retryFailed')">失败重试</button>
          </template>
          <button class="act" @click="viewBatchProducts(detail)">查看商品</button>
        </div>
        <div v-if="isAdmin" class="small muted" style="margin-top: 6px">
          超级管理员只读视图：可查看任意客户端的批次与任务，不能开始/暂停/停止或重新抓取。
        </div>
        <!-- 运行前检查结果：不通过时显示具体错误与重新检测 -->
        <div v-if="precheckErrors.length" class="alert-bar err" style="margin-top: 8px">
          运行前检查未通过：
          <ul style="margin: 4px 0; padding-left: 18px">
            <li v-for="e in precheckErrors" :key="e">{{ e }}</li>
          </ul>
          <button class="act" @click="runPrecheck">重新检测</button>
        </div>
      </div>

      <!-- 任务子表 -->
      <div class="card" style="padding: 8px">
        <div class="form-row">
          <label>结果过滤</label>
          <select v-model="taskStatus" @change="((taskPage = 1), loadTasks())">
            <option v-for="s in TASK_FILTER_OPTIONS" :key="s" :value="s">{{ s ? statusText(s) : '全部' }}</option>
          </select>
        </div>
        <div v-if="!tasks || !tasks.items.length" class="empty">无任务记录。</div>
        <template v-else>
          <table class="list">
            <thead><tr><th>任务</th><th>商品</th><th>状态</th><th>错误码</th><th>更新</th><th></th></tr></thead>
            <tbody>
              <tr v-for="t in tasks.items" :key="t.task_id">
                <td class="mono">{{ t.task_id.slice(0, 8) }}</td>
                <td class="small">
                  {{ t.product?.title ?? '—' }}
                  <div class="muted mono">{{ t.product?.external_product_id ?? t.product_id }}</div>
                </td>
                <td><span :class="statusBadgeClass(t.status)">{{ taskStatusText(t) }}</span></td>
                <td class="small mono">{{ t.last_error_code ?? '—' }}</td>
                <td class="small">{{ formatTime(t.updated_at) }}</td>
                <td>
                  <button class="link" @click="taskDrawer = t">详情</button>
                  <button
                    v-if="!isAdmin && ['SKIPPED', 'FAILED'].includes(t.status)"
                    class="link"
                    :disabled="acting"
                    @click="recollectTask(t)"
                  >重新抓取</button>
                </td>
              </tr>
            </tbody>
          </table>
          <div class="pager">
            <button class="act" :disabled="taskPage <= 1" @click="((taskPage--), loadTasks())">上一页</button>
            <span>第 {{ tasks.page }} 页 / 共 {{ tasks.total }} 任务</span>
            <button class="act" :disabled="taskPage * 20 >= tasks.total" @click="((taskPage++), loadTasks())">下一页</button>
          </div>
        </template>
      </div>

      <!-- 采集尝试时间线（错误与恢复事件） -->
      <div class="card">
        <h3>采集尝试时间线（最近 {{ attempts.length }} 条）</h3>
        <div v-if="!attempts.length" class="empty">暂无采集尝试记录。</div>
        <table v-else class="list">
          <thead><tr><th>时间</th><th>任务</th><th>阶段</th><th>结果</th><th>错误码</th></tr></thead>
          <tbody>
            <tr v-for="a in attempts" :key="a.attempt_id">
              <td class="small">{{ formatTime(a.started_at) }}</td>
              <td class="mono small">{{ a.task_id.slice(0, 8) }}</td>
              <td class="small">{{ a.stage ?? '—' }}</td>
              <td><span :class="statusBadgeClass(a.result)">{{ statusText(a.result) }}</span></td>
              <td class="small mono">{{ a.error_code ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- 单任务侧滑抽屉 -->
    <template v-if="taskDrawer">
      <div class="drawer-mask" @click="taskDrawer = null"></div>
      <div class="drawer">
        <h3>任务详情</h3>
        <div class="kv"><b>任务 ID</b><span class="mono">{{ taskDrawer.task_id }}</span></div>
        <div class="kv"><b>批次</b><span class="mono">{{ taskDrawer.batch_id.slice(0, 8) }}</span></div>
        <div class="kv"><b>状态</b><span :class="statusBadgeClass(taskDrawer.status)">{{ taskStatusText(taskDrawer) }}</span></div>
        <div class="kv"><b>尝试次数</b><span>{{ taskDrawer.attempt_count ?? '—' }}</span></div>
        <div class="kv"><b>错误码</b><span class="mono">{{ taskDrawer.last_error_code ?? '—' }}</span></div>
        <div class="kv"><b>租约到期</b><span>{{ formatTime(taskDrawer.lease_expires_at) }}</span></div>
        <div class="kv"><b>商品</b><span>{{ taskDrawer.product?.title ?? '—' }}</span></div>
        <div class="kv"><b>TikTok ID</b><span class="mono">{{ taskDrawer.product?.external_product_id ?? taskDrawer.product_id }}</span></div>
        <div class="kv"><b>站点</b><span>{{ taskDrawer.product?.region ?? '—' }}</span></div>
        <div class="kv"><b>创建/更新</b><span>{{ formatTime(taskDrawer.created_at) }} / {{ formatTime(taskDrawer.updated_at) }}</span></div>
        <div class="btn-row" style="margin-top: 10px">
          <button
            v-if="!isAdmin && ['SKIPPED', 'FAILED'].includes(taskDrawer.status)"
            class="primary"
            :disabled="acting"
            @click="recollectTask(taskDrawer)"
          >重新抓取</button>
          <button class="act" @click="taskDrawer = null">关闭</button>
        </div>
      </div>
    </template>
  </div>
</template>
