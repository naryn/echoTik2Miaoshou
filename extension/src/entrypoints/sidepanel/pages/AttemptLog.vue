<script setup lang="ts">
/**
 * 执行日志页 AttemptLog（规范 §3.6）
 * - 筛选：时间范围/批次/任务/商品 ID（本页内）/阶段（本页内）/结果/错误码
 * - 表格：attempt_id、目标 URL（由任务关联展示）、阶段、结果、错误码、耗时、开始/结束、证据摘要（折叠展开）
 * - 安全：不展示任何 Cookie/Token/凭证，evidence_json 渲染前按键名脱敏
 */
import { computed, onMounted, ref } from 'vue';
import { sendMsg } from '@/shared/messaging';
import type { AttemptItem, Paginated } from '@/shared/types';
import { classifyError, formatElapsed, formatTime, statusBadgeClass, statusText } from '../utils';

/** 阶段选项（任务状态机阶段） */
const STAGE_OPTIONS = [
  '', 'LEASED', 'NAVIGATING', 'PAGE_READY', 'SUBMITTING', 'SUBMITTED',
  'SUCCESS', 'FAILED', 'UNKNOWN', 'SKIPPED', 'WAITING_VERIFICATION', 'RECOVERING',
];

/** 结果选项 */
const RESULT_OPTIONS = ['', 'SUCCESS', 'FAILED', 'UNKNOWN', 'SKIPPED'];

/** 筛选条件 */
const filter = ref({
  date_from: '',
  date_to: '',
  batch_id: '',
  task_id: '',
  product_id: '', // 服务端不支持，本页内过滤
  stage: '', // 服务端不支持，本页内过滤
  result: '',
  error_code: '',
});
const page = ref(1);
const perPage = ref(20);
const data = ref<Paginated<AttemptItem> | null>(null);
const loading = ref(false);
const errorText = ref<string | null>(null);

/** 展开的证据（attempt_id 集合） */
const expanded = ref<Set<string>>(new Set());

/** 本页内过滤（商品 ID / 阶段：服务端暂不支持这两个维度） */
const visibleItems = computed(() => {
  let items = data.value?.items ?? [];
  if (filter.value.stage) items = items.filter((a) => a.stage === filter.value.stage);
  if (filter.value.product_id) {
    const kw = filter.value.product_id.trim();
    items = items.filter((a) => JSON.stringify(a.evidence_json ?? {}).includes(kw) || a.task_id.includes(kw));
  }
  return items;
});

/**
 * 加载日志（服务端筛选维度：时间/批次/任务/结果/错误码）
 */
async function load(): Promise<void> {
  loading.value = true;
  errorText.value = null;
  try {
    data.value = await sendMsg('attempt.list', {
      date_from: filter.value.date_from ? new Date(filter.value.date_from).toISOString() : undefined,
      date_to: filter.value.date_to ? new Date(filter.value.date_to + 'T23:59:59').toISOString() : undefined,
      batch_id: filter.value.batch_id || undefined,
      task_id: filter.value.task_id || undefined,
      result: filter.value.result || undefined,
      error_code: filter.value.error_code || undefined,
      page: page.value,
      per_page: perPage.value,
    });
  } catch (e) {
    errorText.value = classifyError(e).text;
    data.value = null;
  } finally {
    loading.value = false;
  }
}

/**
 * 应用筛选（重置页码）
 */
function applyFilter(): void {
  page.value = 1;
  void load();
}

/**
 * 证据摘要：按键名脱敏后取前若干字段
 * @param ev evidence_json
 */
function evidenceSummary(ev?: Record<string, unknown> | null): string {
  if (!ev) return '—';
  const s = JSON.stringify(sanitize(ev));
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}

/**
 * 脱敏：递归剔除 Cookie/Token/凭证类键（规范 §3.6/§10）
 * @param obj 原始对象
 */
function sanitize(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sanitize);
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (/cookie|token|authorization|password|secret|credential/i.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitize(v);
      }
    }
    return out;
  }
  return obj;
}

/**
 * 格式化证据全文（脱敏 + 缩进）
 * @param ev evidence_json
 */
function evidencePretty(ev?: Record<string, unknown> | null): string {
  return JSON.stringify(sanitize(ev ?? {}), null, 2);
}

/**
 * 切换证据展开
 * @param id attempt_id
 */
function toggleExpand(id: string): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

onMounted(load);
</script>

<template>
  <div>
    <div v-if="errorText" class="alert-bar err">{{ errorText }}</div>

    <!-- 筛选 -->
    <div class="card">
      <div class="form-row">
        <label>时间范围</label>
        <input v-model="filter.date_from" type="date" @change="applyFilter" />
        <input v-model="filter.date_to" type="date" @change="applyFilter" />
      </div>
      <div class="form-row">
        <label>批次 ID</label>
        <input v-model="filter.batch_id" placeholder="批次 ID（精确）" @keyup.enter="applyFilter" />
      </div>
      <div class="form-row">
        <label>任务 ID</label>
        <input v-model="filter.task_id" placeholder="任务 ID（精确）" @keyup.enter="applyFilter" />
      </div>
      <div class="form-row">
        <label>商品 ID</label>
        <input v-model="filter.product_id" placeholder="本页内匹配证据/任务" />
        <label style="width: auto">阶段</label>
        <select v-model="filter.stage">
          <option v-for="s in STAGE_OPTIONS" :key="s" :value="s">{{ s ? statusText(s) : '全部' }}</option>
        </select>
      </div>
      <div class="form-row">
        <label>结果</label>
        <select v-model="filter.result" @change="applyFilter">
          <option v-for="r in RESULT_OPTIONS" :key="r" :value="r">{{ r ? statusText(r) : '全部' }}</option>
        </select>
        <input v-model="filter.error_code" placeholder="错误码" @keyup.enter="applyFilter" />
        <button class="act" @click="applyFilter">查询</button>
      </div>
      <p class="muted small" style="margin: 0">商品 ID 与阶段筛选仅作用于当前页结果；日志不含 Cookie/Token 等敏感信息。</p>
    </div>

    <!-- 日志表 -->
    <div class="card" style="padding: 8px">
      <div v-if="loading" class="muted small" style="padding: 12px">加载中…</div>
      <div v-else-if="!visibleItems.length" class="empty">没有符合条件的采集尝试记录。</div>
      <template v-else>
        <table class="list">
          <thead>
            <tr><th>attempt</th><th>任务</th><th>阶段</th><th>结果</th><th>错误码</th><th>耗时</th><th>开始/结束</th><th>证据</th></tr>
          </thead>
          <tbody>
            <template v-for="a in visibleItems" :key="a.attempt_id">
              <tr>
                <td class="mono">{{ a.attempt_id.slice(0, 8) }}</td>
                <td class="mono">{{ a.task_id.slice(0, 8) }}</td>
                <td class="small">{{ a.stage ?? '—' }}</td>
                <td><span :class="statusBadgeClass(a.result)">{{ statusText(a.result) }}</span></td>
                <td class="mono small">{{ a.error_code ?? '—' }}</td>
                <td class="small">{{ formatElapsed(a.elapsed_ms) }}</td>
                <td class="small">{{ formatTime(a.started_at) }}<br />{{ formatTime(a.finished_at) }}</td>
                <td>
                  <button class="link" @click="toggleExpand(a.attempt_id)">
                    {{ expanded.has(a.attempt_id) ? '收起' : '展开' }}
                  </button>
                  <span class="muted small">{{ evidenceSummary(a.evidence_json) }}</span>
                </td>
              </tr>
              <tr v-if="expanded.has(a.attempt_id)">
                <td colspan="8">
                  <pre class="mono small" style="white-space: pre-wrap; margin: 4px 0; background: #f9fafb; padding: 8px; border-radius: 6px">{{ evidencePretty(a.evidence_json) }}</pre>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
        <div class="pager" v-if="data">
          <button class="act" :disabled="page <= 1" @click="((page--), load())">上一页</button>
          <span>第 {{ data.page }} 页 / 共 {{ data.total }} 条</span>
          <button class="act" :disabled="page * perPage >= data.total" @click="((page++), load())">下一页</button>
          <select v-model.number="perPage" @change="applyFilter">
            <option :value="20">20/页</option>
            <option :value="50">50/页</option>
            <option :value="100">100/页</option>
          </select>
        </div>
      </template>
    </div>
  </div>
</template>
