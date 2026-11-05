<script setup lang="ts">
/**
 * 设置页 Settings（规范 §3.7）
 * - 客户端卡：client_id（只读可复制）/名称/版本/注册时间/最后同步/远程地址编辑+连接测试/重新绑定（二次确认）
 * - EchoTik 卡：登录状态检测、适配器版本、字段映射检查入口
 * - TikTok/妙手卡：工作 Tab 选择、妙手选择器版本、测试采集流程入口（PoC 待验证）
 * - 执行参数：任务间隔 min/max（默认 15–30s）/单批上限/页面等待超时/按钮检测超时/提交结果等待/失败最大重试次数
 * - 行为：关闭面板继续任务、异常通知、日志保留天数
 * - 数据：本地缓存大小、未同步 outbox 数、手动同步、清理缓存（不删远程任务）、导出诊断信息
 */
import { onMounted, ref } from 'vue';
import { browser } from 'wxt/browser';
import { sendMsg } from '@/shared/messaging';
import type { ClientMe } from '@/shared/types';
import type { MessageMap } from '@/shared/types/messages';
import { DEFAULT_MIAOSHOU_SELECTORS } from '@/modules/miaoshou/adapter';
import { outboxPending, storageGet, storageSet } from '@/modules/storage';
import { loadBehaviorConfig, loadExecConfig, refreshState, saveBehaviorConfig, saveExecConfig, store } from '../store';
import { classifyError, downloadText, formatTime } from '../utils';

/** 适配器版本（与 modules/echotik/adapter capabilities 保持一致） */
const ADAPTER_VERSION = 'echotik-web-adapter/0.1';

/** 远程客户端信息 */
const me = ref<ClientMe | null>(null);
/** 本地身份信息 */
const localInfo = ref({ client_id: null as string | null, registered_at: null as string | null, server_url: '' });
/** 远程地址编辑 */
const serverUrlEdit = ref('');
/** 重新绑定确认 */
const confirmRebind = ref(false);
/** 环境探测 */
const env = ref<MessageMap['env.check']['res'] | null>(null);
const envLoading = ref(false);
/** TikTok 候选标签页 */
const tiktokTabs = ref<{ id?: number; title?: string; url?: string }[]>([]);
/** 当前工作 Tab */
const workerTabId = ref<number | null>(null);
/** 执行参数 */
const exec = ref({ interval_min_sec: 15, interval_max_sec: 30, batch_max: 200, page_wait_timeout_sec: 30, button_detect_timeout_sec: 15, submit_result_wait_sec: 20, max_retries: 2 });
/** 行为配置 */
const behavior = ref({ continue_on_panel_close: true, notify_on_exception: true, log_retention_days: 7 });
/** 数据统计 */
const dataStats = ref({ cacheBytes: null as number | null, outbox: null as number | null });
/** 反馈信息 */
const feedback = ref<string | null>(null);
const errorText = ref<string | null>(null);
/** 测试采集流程结果 */
const pocResult = ref<string | null>(null);
const pocRunning = ref(false);

/**
 * 复制文本到剪贴板
 * @param text 文本
 */
async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  feedback.value = '已复制到剪贴板。';
}

/**
 * 连接测试：以 /v1/clients/me 探测（真实服务端响应为准）
 */
async function testConnection(): Promise<void> {
  errorText.value = null;
  try {
    const t0 = Date.now();
    await sendMsg('client.me', undefined);
    feedback.value = `连接正常（${Date.now() - t0}ms）。`;
  } catch (e) {
    errorText.value = classifyError(e).text;
  }
}

/**
 * 保存远程地址（保存后提示连接测试结果）
 */
async function saveServerUrl(): Promise<void> {
  const url = serverUrlEdit.value.trim();
  if (!/^https?:\/\//.test(url)) {
    errorText.value = '远程地址格式不正确（需以 http(s):// 开头）';
    return;
  }
  await storageSet('server_url', url);
  localInfo.value.server_url = url;
  feedback.value = '远程地址已保存，正在测试连接…';
  await testConnection();
}

/**
 * 重新绑定：清空本地凭证并触发重新注册（危险动作，二次确认）
 */
async function rebind(): Promise<void> {
  confirmRebind.value = false;
  errorText.value = null;
  try {
    await sendMsg('client.register', { force: true });
    await refreshState();
    await loadMe();
    feedback.value = '已重新注册/绑定。';
  } catch (e) {
    errorText.value = classifyError(e).text;
  }
}

/**
 * 加载远程客户端信息
 */
async function loadMe(): Promise<void> {
  me.value = await sendMsg('client.me', undefined).catch(() => null);
}

/**
 * 检测 EchoTik 登录状态（env.check）
 */
async function checkEnv(): Promise<void> {
  envLoading.value = true;
  try {
    env.value = await sendMsg('env.check', undefined);
  } catch (e) {
    errorText.value = classifyError(e).text;
  } finally {
    envLoading.value = false;
  }
}

/**
 * 刷新 TikTok 候选标签页列表（含真实商品页域名 shop.tiktok.com）
 */
async function loadTiktokTabs(): Promise<void> {
  const tabs = await browser.tabs.query({ url: ['*://www.tiktok.com/*', '*://shop.tiktok.com/*'] });
  tiktokTabs.value = tabs.map((t) => ({ id: t.id, title: t.title, url: t.url }));
  workerTabId.value = await storageGet('worker_tab_id');
}

/**
 * 选择工作 Tab
 * @param id 标签页 id
 */
async function setWorkerTab(id: number): Promise<void> {
  await sendMsg('client.setWorkerTab', { tabId: id });
  workerTabId.value = id;
  feedback.value = '已设置 TikTok 工作 Tab。';
}

/**
 * 测试采集流程（PoC 待验证）：对当前工作 Tab 做一次妙手检测探针
 */
async function testPoc(): Promise<void> {
  pocRunning.value = true;
  pocResult.value = null;
  try {
    const r = await sendMsg('tiktok.detectMiaoshou', undefined, workerTabId.value ?? undefined);
    pocResult.value = r.available
      ? `检测到妙手按钮：${r.evidence || 'ok'}`
      : `未检测到：${r.reason || '页面未就绪或妙手未注入'}（PoC 待验证）`;
  } catch (e) {
    pocResult.value = `探测失败：${(e as Error).message}（PoC 待验证）`;
  } finally {
    pocRunning.value = false;
  }
}

/**
 * 保存执行参数
 */
async function saveExec(): Promise<void> {
  if (exec.value.interval_min_sec > exec.value.interval_max_sec) {
    errorText.value = '任务间隔 min 不能大于 max';
    return;
  }
  await saveExecConfig({ ...exec.value });
  feedback.value = '执行参数已保存，新任务间隔即时生效。';
}

/**
 * 保存行为配置
 */
async function saveBehavior(): Promise<void> {
  await saveBehaviorConfig({ ...behavior.value });
  feedback.value = '行为配置已保存。';
}

/**
 * 手动同步 outbox
 */
async function manualSync(): Promise<void> {
  try {
    const r = await sendMsg('outbox.flush', undefined);
    dataStats.value.outbox = r.remaining;
    feedback.value = `补传完成：成功 ${r.synced} 条，剩余 ${r.remaining} 条。`;
  } catch (e) {
    errorText.value = classifyError(e).text;
  }
}

/**
 * 清理本地缓存（类目缓存/筛选缓存等，不影响远程任务与本地凭证）
 */
async function clearCache(): Promise<void> {
  await storageSet('category_cache', null);
  await storageSet('last_filters', {});
  feedback.value = '本地缓存已清理（未影响远程任务与本地凭证）。';
  await loadDataStats();
}

/**
 * 导出诊断信息（不含任何凭证/token）
 */
async function exportDiagnostics(): Promise<void> {
  const diag = {
    exported_at: new Date().toISOString(),
    version: ADAPTER_VERSION,
    state: { ...store.state, client_id: store.state?.client_id ? '[redacted-id]' : null },
    server_url: localInfo.value.server_url,
    exec_config: exec.value,
    behavior_config: behavior.value,
    outbox_pending: dataStats.value.outbox,
    env: env.value,
  };
  downloadText(`echotik-diagnostics-${Date.now()}.json`, JSON.stringify(diag, null, 2), 'application/json');
  feedback.value = '诊断信息已导出（不含凭证）。';
}

/**
 * 加载数据统计（本地缓存大小估算 + outbox 数）
 */
async function loadDataStats(): Promise<void> {
  try {
    dataStats.value.cacheBytes = await browser.storage.local.getBytesInUse(null);
  } catch {
    dataStats.value.cacheBytes = null;
  }
  dataStats.value.outbox = (await outboxPending()).length;
}

onMounted(async () => {
  localInfo.value = {
    client_id: await storageGet('client_id'),
    registered_at: await storageGet('registered_at'),
    server_url: await storageGet('server_url'),
  };
  serverUrlEdit.value = localInfo.value.server_url;
  exec.value = await loadExecConfig();
  behavior.value = await loadBehaviorConfig();
  await Promise.all([loadMe(), checkEnv(), loadTiktokTabs(), loadDataStats()]);
});
</script>

<template>
  <div>
    <div v-if="errorText" class="alert-bar err">{{ errorText }}</div>
    <div v-if="feedback" class="alert-bar" style="background:#f0fdf4;border-color:#bbf7d0;color:#166534">{{ feedback }}</div>

    <!-- 客户端卡 -->
    <div class="card">
      <h3>客户端</h3>
      <div class="kv small" style="display: flex; margin-bottom: 6px">
        <b style="width: 88px; color: #6b7280">client_id</b>
        <span class="mono">{{ localInfo.client_id ?? '未注册' }}</span>
        <button v-if="localInfo.client_id" class="link" @click="copyText(localInfo.client_id!)">复制</button>
      </div>
      <div class="small">名称：{{ me?.display_name ?? '—' }}（名称在服务端注册信息中维护）</div>
      <div class="small">扩展版本：{{ me?.extension_version ?? ADAPTER_VERSION }}</div>
      <div class="small">注册时间：{{ formatTime(localInfo.registered_at ?? me?.registered_at) }}</div>
      <div class="small">最后同步：{{ formatTime(me?.last_seen_at) }}</div>
      <div class="form-row" style="margin-top: 8px">
        <label>远程地址</label>
        <input v-model="serverUrlEdit" placeholder="http://localhost:8001" />
        <button class="act" @click="saveServerUrl">保存</button>
        <button class="act" @click="testConnection">连接测试</button>
      </div>
      <div class="btn-row">
        <button class="act danger" @click="confirmRebind = true">重新绑定</button>
      </div>
    </div>

    <!-- EchoTik 卡 -->
    <div class="card">
      <h3>
        EchoTik
        <button class="link" :disabled="envLoading" @click="checkEnv">{{ envLoading ? '检测中…' : '重新检测' }}</button>
      </h3>
      <div class="small">
        登录状态：
        <span :class="env?.echotik.logged_in ? 'badge ok' : 'badge warn'">
          {{ !env ? '未检测' : !env.echotik.tab_found ? '页面未打开' : env.echotik.logged_in === null ? '未知' : env.echotik.logged_in ? '已登录' : '未登录' }}
        </span>
        <span class="muted">{{ env?.echotik.evidence }}</span>
      </div>
      <div class="small">适配器版本：<span class="mono">{{ ADAPTER_VERSION }}</span></div>
      <div class="small muted">
        字段映射检查：见仓库 docs/adapters/echotik-mapping.md（每季度核对）。
        <button class="link" @click="loadDataStats">刷新</button>
      </div>
    </div>

    <!-- TikTok / 妙手卡 -->
    <div class="card">
      <h3>TikTok / 妙手</h3>
      <div class="form-row">
        <label>工作 Tab</label>
        <select :value="workerTabId ?? ''" @change="setWorkerTab(Number(($event.target as HTMLSelectElement).value))">
          <option value="" disabled>选择 TikTok 标签页</option>
          <option v-for="t in tiktokTabs" :key="t.id" :value="t.id">{{ t.title?.slice(0, 40) || t.url }}</option>
        </select>
        <button class="act" @click="loadTiktokTabs">刷新</button>
      </div>
      <div class="small">妙手选择器版本：<span class="mono">{{ DEFAULT_MIAOSHOU_SELECTORS.version }}</span>（PoC 待验证）</div>
      <div class="small">
        妙手检测：
        <span :class="env?.miaoshou.available ? 'badge ok' : 'badge warn'">
          {{ !env?.miaoshou.checked ? '未检测' : env?.miaoshou.available === null ? '未知' : env?.miaoshou.available ? '已检测' : '未检测到' }}
        </span>
        <span class="muted">{{ env?.miaoshou.evidence }}</span>
      </div>
      <div class="btn-row">
        <button class="act" :disabled="pocRunning" @click="testPoc">测试采集流程（PoC 待验证）</button>
      </div>
      <p v-if="pocResult" class="small muted" style="margin-bottom: 0">{{ pocResult }}</p>
    </div>

    <!-- 执行参数 -->
    <div class="card">
      <h3>执行参数</h3>
      <div class="form-row">
        <label>任务间隔(秒)</label>
        <input v-model.number="exec.interval_min_sec" type="number" min="1" style="max-width: 70px" />
        <span class="muted">至</span>
        <input v-model.number="exec.interval_max_sec" type="number" min="1" style="max-width: 70px" />
        <span class="muted small">默认 15–30</span>
      </div>
      <div class="form-row">
        <label>单批上限</label>
        <input v-model.number="exec.batch_max" type="number" min="1" style="max-width: 90px" />
      </div>
      <div class="form-row">
        <label>页面等待超时</label>
        <input v-model.number="exec.page_wait_timeout_sec" type="number" min="1" style="max-width: 70px" />
        <span class="muted small">秒</span>
      </div>
      <div class="form-row">
        <label>按钮检测超时</label>
        <input v-model.number="exec.button_detect_timeout_sec" type="number" min="1" style="max-width: 70px" />
        <span class="muted small">秒</span>
      </div>
      <div class="form-row">
        <label>提交结果等待</label>
        <input v-model.number="exec.submit_result_wait_sec" type="number" min="1" style="max-width: 70px" />
        <span class="muted small">秒</span>
      </div>
      <div class="form-row">
        <label>失败最大重试</label>
        <input v-model.number="exec.max_retries" type="number" min="0" style="max-width: 70px" />
        <span class="muted small">次</span>
      </div>
      <p class="muted small">仅暂时性故障自动重试；验证码/访问限制不自动重试，转为等待人工处理。</p>
      <div class="btn-row"><button class="primary" @click="saveExec">保存执行参数</button></div>
    </div>

    <!-- 行为 -->
    <div class="card">
      <h3>行为</h3>
      <div class="form-row">
        <input id="b1" v-model="behavior.continue_on_panel_close" type="checkbox" />
        <label for="b1" style="width: auto">关闭面板后继续任务（权威状态在服务端，本项仅作偏好记录）</label>
      </div>
      <div class="form-row">
        <input id="b2" v-model="behavior.notify_on_exception" type="checkbox" />
        <label for="b2" style="width: auto">异常时系统通知</label>
      </div>
      <div class="form-row">
        <label>日志保留天数</label>
        <input v-model.number="behavior.log_retention_days" type="number" min="1" style="max-width: 70px" />
      </div>
      <div class="btn-row"><button class="primary" @click="saveBehavior">保存行为配置</button></div>
    </div>

    <!-- 数据 -->
    <div class="card">
      <h3>数据</h3>
      <div class="small">本地缓存大小：{{ dataStats.cacheBytes != null ? (dataStats.cacheBytes / 1024).toFixed(1) + ' KB' : '—' }}</div>
      <div class="small">未同步 outbox：{{ dataStats.outbox ?? '—' }} 条</div>
      <div class="btn-row" style="flex-wrap: wrap">
        <button class="act" @click="manualSync">手动同步</button>
        <button class="act" @click="clearCache">清理缓存（不删远程任务）</button>
        <button class="act" @click="exportDiagnostics">导出诊断信息</button>
      </div>
    </div>

    <!-- 重新绑定二次确认 -->
    <div v-if="confirmRebind" class="confirm-mask" @click.self="confirmRebind = false">
      <div class="confirm-box">
        <p>重新绑定将清空本地客户端凭证并重新注册。远程任务与数据不受影响。确认继续？</p>
        <div class="btn-row" style="justify-content: flex-end">
          <button class="act" @click="confirmRebind = false">取消</button>
          <button class="act danger" @click="rebind">确认重新绑定</button>
        </div>
      </div>
    </div>
  </div>
</template>
