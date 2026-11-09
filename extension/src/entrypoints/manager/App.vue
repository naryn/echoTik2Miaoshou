<script setup lang="ts">
/**
 * 管理台应用外壳（独立页面窗口，规范 §3.1 全局固定区）：
 * 标题、客户端短 ID、连接/同步状态灯、当前运行态条、最近异常、六页导航。
 * 危险动作（停止批次）二次确认；刷新/关闭侧栏不影响批次运行。
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { locateWorkerTab, pauseRunner, refreshState, resumeRunner, setAuthToken, store } from './store';
import { storageGet } from '@/modules/storage';

const route = useRoute();

/** 停止批次二次确认弹层开关 */
const confirmCancel = ref(false);
/** 操作进行中 */
const acting = ref(false);

/** 是否已完成激活认证 */
const authorized = computed(() => !!store.state?.authorized);
/** 授权页输入 */
const authInput = ref('');
const authBusy = ref(false);
const authError = ref<string | null>(null);

onMounted(async () => {
  authInput.value = (await storageGet('auth_token')) ?? '';
});

/**
 * 激活授权：验证激活认证码
 */
async function activate(): Promise<void> {
  const token = authInput.value.trim();
  if (!token) {
    authError.value = '请输入激活认证码';
    return;
  }
  authBusy.value = true;
  authError.value = null;
  try {
    await setAuthToken(token);
    if (!store.state?.authorized) authError.value = '激活认证码无效或已停用';
  } catch (e) {
    authError.value = (e as Error).message;
  } finally {
    authBusy.value = false;
  }
}

/** 连接状态灯样式 */
const connClass = computed(() => {
  if (!store.state) return 'conn-dot';
  return store.state.connected ? 'conn-dot on' : 'conn-dot off';
});

/** 连接状态文案 */
const connText = computed(() => {
  if (!store.state) return '加载中';
  if (!store.state.authorized) return '未授权';
  return store.state.connected ? '已连接' : '远端离线';
});

/** 运行条进度百分比 */
const progressPct = computed(() => {
  const p = store.state?.progress;
  if (!p || !p.total) return 0;
  return Math.min(100, Math.round((p.done / p.total) * 100));
});

/** 客户端短 ID */
const shortClientId = computed(() => {
  const id = store.state?.client_id;
  return id ? id.slice(0, 8) : '未注册';
});

/** 当前运行态文案 */
const runStateText = computed(() => {
  const s = store.state;
  if (!s?.active_batch_id) return '';
  if (s.waiting_verification) return '等待人工验证';
  if (s.paused) return '已暂停';
  return '运行中';
});

/**
 * 确认停止批次（危险动作，二次确认后执行）
 */
async function doCancel(): Promise<void> {
  acting.value = true;
  try {
    await sendMsg('runner.cancel', undefined);
    await refreshState();
  } finally {
    acting.value = false;
    confirmCancel.value = false;
  }
}
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <h1>TK 采集助手</h1>
      <span class="client-id">客户端 {{ shortClientId }}</span>
      <span v-if="store.state?.role === 'ADMIN'" class="client-id" title="管理员：可查看所有账号数据">管理员</span>
      <span v-if="store.state?.display_name" class="client-id">{{ store.state.display_name }}</span>
      <span :class="connClass" :title="connText"></span>
      <span class="client-id">{{ connText }}</span>
    </header>

    <nav v-if="authorized" class="app-nav">
      <RouterLink
        v-for="r in [
          { to: '/', label: '概览' },
          { to: '/ranking', label: '榜单采集' },
          { to: '/ranking-history', label: '历史榜单' },
          { to: '/products', label: '商品列表' },
          { to: '/tasks', label: '任务' },
          { to: '/logs', label: '日志' },
          { to: '/settings', label: '设置' },
        ]"
        :key="r.to"
        :to="r.to"
        :class="{ active: route.path === r.to }"
        >{{ r.label }}</RouterLink
      >
    </nav>

    <main class="app-main">
      <!-- 未授权：插件不可用，必须先完成激活认证 -->
      <div v-if="store.state && !authorized" class="card" style="margin-top: 12px">
        <h3>激活认证</h3>
        <p class="small muted">请输入激活认证码后开始使用。</p>
        <div class="form-row">
          <label>激活认证</label>
          <input v-model="authInput" type="password" placeholder="输入激活认证码" @keyup.enter="activate" />
        </div>
        <div class="btn-row">
          <button class="primary" :disabled="authBusy" @click="activate">{{ authBusy ? '验证中…' : '激活' }}</button>
        </div>
        <p v-if="authError" class="alert-bar err" style="margin-bottom: 0">{{ authError }}</p>
      </div>

      <!-- 当前运行态条：批次进行中时全局可见 -->
      <div v-if="authorized && store.state?.active_batch_id" class="run-bar">
        <div>
          当前批次：<span class="mono">{{ store.state.active_batch_id.slice(0, 8) }}</span> ·
          <span :class="{ 'tag-pending-verify': store.state.waiting_verification }">{{ runStateText }}</span>
          <template v-if="store.state.current_product_title">
            · 商品 {{ store.state.current_product_title }}
          </template>
        </div>
        <div class="progress"><div :style="{ width: progressPct + '%' }"></div></div>
        <div v-if="store.state.progress">
          进度 {{ store.state.progress.done }} / {{ store.state.progress.total }}（{{ progressPct }}%）
        </div>
        <div class="btn-row">
          <button v-if="!store.state.paused" class="act" @click="pauseRunner">暂停</button>
          <button v-else class="act" @click="resumeRunner">继续</button>
          <button class="act" @click="locateWorkerTab">查看运行页面</button>
          <button class="act danger" @click="confirmCancel = true">停止批次</button>
        </div>
      </div>

      <!-- 最近异常提示 -->
      <div v-if="authorized && store.error" class="alert-bar err">连接异常：{{ store.error }}</div>
      <div v-else-if="authorized && store.state?.last_error" class="alert-bar">最近异常：{{ store.state.last_error }}</div>

      <RouterView v-if="authorized" />
    </main>

    <!-- 停止批次二次确认 -->
    <div v-if="confirmCancel" class="confirm-mask" @click.self="confirmCancel = false">
      <div class="confirm-box">
        <p>确认停止整个批次？将终止后续任务领取，不会抹掉已完成历史。</p>
        <div class="btn-row" style="justify-content: flex-end">
          <button class="act" @click="confirmCancel = false">取消</button>
          <button class="act danger" :disabled="acting" @click="doCancel">确认停止</button>
        </div>
      </div>
    </div>
  </div>
</template>
