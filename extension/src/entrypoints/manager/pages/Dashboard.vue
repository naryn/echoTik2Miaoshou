<script setup lang="ts">
/**
 * 概览页 Dashboard（规范 §3.2）：
 * KPI 卡（今日发现/去重新增/待 ERP/成功/失败/同步队列）、当前执行卡、
 * 页面环境卡（EchoTik 登录/TikTok 工作 Tab/妙手检测/服务器连通）、快捷操作、异常条。
 * 所有数据来自真实服务端响应或本地存储，不做前端假设。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { sendMsg } from '@/shared/messaging';
import type { BatchItem, RunnerCheckpoint } from '@/shared/types';
import type { MessageMap } from '@/shared/types/messages';
import { outboxPending } from '@/modules/storage';
import { locateWorkerTab, store } from '../store';
import { classifyError, formatTime, statusBadgeClass, statusText } from '../utils';

const router = useRouter();

/** KPI 数值（null = 加载中/不可用） */
const kpi = ref({
  todayFound: null as number | null,
  newToday: null as number | null,
  pendingErp: null as number | null,
  success: null as number | null,
  failed: null as number | null,
  outbox: null as number | null,
});
/** 当前批次详情（含聚合进度） */
const activeBatch = ref<BatchItem | null>(null);
/** 运行检查点（当前商品/更新时间） */
const checkpoint = ref<RunnerCheckpoint | null>(null);
/** 环境探测结果 */
const env = ref<MessageMap['env.check']['res'] | null>(null);
const envLoading = ref(false);
/** 异常条展开的处理建议 */
const alertAdvice = ref<string | null>(null);
/** 快捷操作反馈 */
const actionMsg = ref<string | null>(null);

/** 异常条列表（按规范 §3.2：验证等待/访问限制/网络中断/插件未检测/租约过期） */
const alerts = computed(() => {
  const list: { kind: string; text: string; advice: string }[] = [];
  if (store.state?.waiting_verification) {
    list.push({
      kind: '验证等待',
      text: 'TikTok 页面出现验证/访问限制，已停止领取新任务',
      advice: '请在 TikTok 工作标签页中人工完成验证；页面恢复且妙手按钮可用后扩展将自动继续，无需其他操作。',
    });
  }
  if (store.state && !store.state.connected) {
    list.push({
      kind: '远端离线',
      text: '远程服务器不可达，结果与进度将缓存至本地 outbox',
      advice: '检查网络与服务连接状态（可在设置页测试连接）；恢复后会自动幂等补传，不会重复采集。',
    });
  }
  if (env.value && !env.value.echotik.tab_found) {
    list.push({
      kind: 'EchoTik 未打开',
      text: '未检测到 EchoTik 页面，无法采集榜单',
      advice: '打开并登录 echotik.live 榜单页后，榜单采集相关功能才可用。',
    });
  }
  if (env.value?.echotik.logged_in === false) {
    list.push({
      kind: 'EchoTik 未登录',
      text: 'EchoTik 登录态失效',
      advice: '请在 EchoTik 页面重新登录，然后重试采集。',
    });
  }
  if (env.value && env.value.miaoshou.checked && env.value.miaoshou.available === false) {
    list.push({
      kind: '妙手未检测到',
      text: 'TikTok 工作页未检测到妙手采集按钮',
      advice: '确认妙手官方插件已安装启用，并在 TikTok 商品详情页注入成功；仍不可用请更新选择器版本。',
    });
  }
  return list;
});

/** 已用时（批次开始至今） */
const elapsedText = computed(() => {
  const start = activeBatch.value?.started_at;
  if (!start) return '—';
  const ms = Date.now() - Date.parse(start);
  if (ms < 0) return '—';
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
});

/**
 * 加载 KPI：今日发现（今日快照覆盖的商品数）、去重新增（今日首次发现，按最新 100 条估算）、
 * 待 ERP / 成功 / 失败（erp_status 总数）、outbox 未同步数
 */
async function loadKpi(): Promise<void> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();
  // 各请求独立容错：单项失败仅该 KPI 显示 —
  const safe = async (fn: () => Promise<number>, key: keyof typeof kpi.value) => {
    try {
      kpi.value[key] = await fn();
    } catch {
      kpi.value[key] = null;
    }
  };
  await Promise.all([
    safe(async () => (await sendMsg('product.list', { snapshot_date_from: todayIso, per_page: 20 })).total, 'todayFound'),
    safe(async () => {
      const r = await sendMsg('product.list', { sort: 'first_seen_at', order: 'desc', per_page: 100 });
      return r.items.filter((p) => p.first_seen_at && Date.parse(p.first_seen_at) >= todayStart.getTime()).length;
    }, 'newToday'),
    safe(async () => (await sendMsg('product.list', { erp_status: 'NEVER', per_page: 20 })).total, 'pendingErp'),
    safe(async () => (await sendMsg('product.list', { erp_status: 'SUCCESS', per_page: 20 })).total, 'success'),
    safe(async () => (await sendMsg('product.list', { erp_status: 'FAILED', per_page: 20 })).total, 'failed'),
    safe(async () => (await outboxPending()).length, 'outbox'),
  ]);
}

/**
 * 加载当前执行卡数据：批次详情 + 本地检查点
 */
async function loadExecution(): Promise<void> {
  const batchId = store.state?.active_batch_id;
  checkpoint.value = await sendMsg('runner.getCheckpoint', undefined).catch(() => null);
  if (!batchId) {
    activeBatch.value = null;
    return;
  }
  activeBatch.value = await sendMsg('batch.get', { batch_id: batchId }).catch(() => null);
}

/**
 * 页面环境探测（经 background env.check 消息）
 */
async function checkEnv(): Promise<void> {
  envLoading.value = true;
  try {
    env.value = await sendMsg('env.check', undefined);
  } catch {
    env.value = null;
  } finally {
    envLoading.value = false;
  }
}

/**
 * 快捷操作：采集当前 EchoTik 榜单（读取当前页面条件直接启动）
 */
async function collectCurrent(): Promise<void> {
  actionMsg.value = null;
  try {
    await sendMsg('snapshot.createFromCurrent', undefined);
    actionMsg.value = '已按当前页面条件启动采集，进度见榜单采集页。';
    router.push('/ranking');
  } catch (e) {
    actionMsg.value = classifyError(e).text;
  }
}

/**
 * 快捷操作：继续上次批次（恢复 runner）
 */
async function resumeLast(): Promise<void> {
  actionMsg.value = null;
  try {
    await sendMsg('runner.resume', undefined);
    actionMsg.value = '已请求继续，等待调度。';
  } catch (e) {
    actionMsg.value = classifyError(e).text;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  await Promise.all([loadKpi(), loadExecution(), checkEnv()]);
  // 30s 周期刷新执行卡与 KPI（轻量，全部走缓存友好端点）
  timer = setInterval(() => void Promise.all([loadKpi(), loadExecution()]), 30_000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div>
    <!-- 异常条（规范 §3.2：点击显示处理建议） -->
    <template v-if="alerts.length">
      <div
        v-for="a in alerts"
        :key="a.kind"
        class="alert-bar"
        :class="{ err: a.kind === '远端离线' }"
        @click="alertAdvice = alertAdvice === a.advice ? null : a.advice"
      >
        ⚠ {{ a.kind }}：{{ a.text }}
        <div v-if="alertAdvice === a.advice" class="small" style="margin-top: 4px">处理建议：{{ a.advice }}</div>
      </div>
    </template>

    <!-- KPI 卡 -->
    <div class="kpi-grid">
      <div class="kpi"><div class="num">{{ kpi.todayFound ?? '—' }}</div><div class="label">今日发现</div></div>
      <div class="kpi"><div class="num">{{ kpi.newToday ?? '—' }}</div><div class="label">去重新增*</div></div>
      <div class="kpi"><div class="num">{{ kpi.pendingErp ?? '—' }}</div><div class="label">待 ERP</div></div>
      <div class="kpi"><div class="num">{{ kpi.success ?? '—' }}</div><div class="label">成功</div></div>
      <div class="kpi"><div class="num">{{ kpi.failed ?? '—' }}</div><div class="label">失败</div></div>
      <div class="kpi"><div class="num">{{ kpi.outbox ?? '—' }}</div><div class="label">同步队列</div></div>
    </div>
    <p class="muted small" style="margin-top: -6px">* 去重新增按最近 100 条首次发现时间统计，仅供参考。</p>

    <!-- 当前执行卡 -->
    <div class="card">
      <h3>当前执行</h3>
      <template v-if="activeBatch">
        <div class="small">
          批次 <span class="mono">{{ activeBatch.batch_id.slice(0, 8) }}</span>
          <span :class="statusBadgeClass(activeBatch.status)">{{ statusText(activeBatch.status) }}</span>
        </div>
        <div class="small muted" v-if="activeBatch.source_snapshot_id">
          来源榜单快照：<span class="mono">{{ activeBatch.source_snapshot_id.slice(0, 8) }}</span>
        </div>
        <div class="progress" style="margin: 8px 0">
          <div
            :style="{
              width:
                (activeBatch.summary?.total ?? 0) > 0
                  ? Math.round(
                      (((activeBatch.summary?.success ?? 0) +
                        (activeBatch.summary?.failed ?? 0) +
                        (activeBatch.summary?.skipped ?? 0) +
                        (activeBatch.summary?.unknown ?? 0)) /
                        (activeBatch.summary?.total ?? 1)) * 100,
                    ) + '%'
                  : '0%',
            }"
          ></div>
        </div>
        <div class="small">
          已处理
          {{ (activeBatch.summary?.success ?? 0) + (activeBatch.summary?.failed ?? 0) + (activeBatch.summary?.skipped ?? 0) + (activeBatch.summary?.unknown ?? 0) }}
          / {{ activeBatch.summary?.total ?? '—' }} · 成功 {{ activeBatch.summary?.success ?? 0 }} · 跳过
          {{ activeBatch.summary?.skipped ?? 0 }} · 失败 {{ activeBatch.summary?.failed ?? 0 }} · 不确定
          {{ activeBatch.summary?.unknown ?? 0 }}
        </div>
        <div class="small muted" v-if="checkpoint?.product">
          当前商品：{{ checkpoint.product.external_product_id }}（{{ checkpoint.product.region }}）
        </div>
        <div class="small muted">已用时 {{ elapsedText }} · 检查点更新 {{ formatTime(checkpoint?.updated_at) }}</div>
      </template>
      <div v-else class="empty">当前没有正在执行的批次。可在「榜单采集」获取榜单后创建批次，或在「任务」页启动已有批次。</div>
    </div>

    <!-- 页面环境卡 -->
    <div class="card">
      <h3>
        页面环境
        <button class="link" :disabled="envLoading" @click="checkEnv">{{ envLoading ? '检测中…' : '重新检测' }}</button>
      </h3>
      <template v-if="env">
        <div class="small">
          EchoTik：
          <span :class="env.echotik.logged_in ? 'badge ok' : 'badge warn'">
            {{ !env.echotik.tab_found ? '页面未打开' : env.echotik.logged_in === null ? '未知' : env.echotik.logged_in ? '已登录' : '未登录' }}
          </span>
          <span class="muted">{{ env.echotik.evidence }}</span>
        </div>
        <div class="small">
          TikTok 工作 Tab：
          <span :class="env.tiktok.worker_tab_found ? 'badge ok' : 'badge'">{{ env.tiktok.worker_tab_found ? '存在' : '未创建' }}</span>
        </div>
        <div class="small">
          妙手插件：
          <span :class="env.miaoshou.available ? 'badge ok' : 'badge warn'">
            {{ !env.miaoshou.checked ? '未检测' : env.miaoshou.available === null ? '未知' : env.miaoshou.available ? '已检测' : '未检测到' }}
          </span>
          <span class="muted">{{ env.miaoshou.evidence }}</span>
        </div>
        <div class="small">
          服务器：
          <span :class="env.server.connected ? 'badge ok' : 'badge err'">{{ env.server.connected ? '连通' : '不可达' }}</span>
          <span class="muted" v-if="env.server.latency_ms != null">{{ env.server.latency_ms }}ms</span>
        </div>
      </template>
      <div v-else class="muted small">尚未检测。</div>
    </div>

    <!-- 快捷操作 -->
    <div class="card">
      <h3>快捷操作</h3>
      <div class="btn-row" style="flex-wrap: wrap">
        <button class="act" @click="collectCurrent">采集当前榜单</button>
        <button class="act" :disabled="!store.state?.active_batch_id" @click="resumeLast">继续上次批次</button>
        <button class="act" @click="router.push('/tasks')">打开任务列表</button>
        <button class="act" @click="locateWorkerTab">定位 TikTok 商品</button>
      </div>
      <p v-if="actionMsg" class="small muted" style="margin-bottom: 0">{{ actionMsg }}</p>
    </div>
  </div>
</template>
