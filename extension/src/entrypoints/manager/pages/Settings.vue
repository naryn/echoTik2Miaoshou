<script setup lang="ts">
/**
 * 设置页 Settings（规范 §3.7）
 * - 客户端卡：client_id（只读可复制）/名称/版本/注册时间/最后同步/服务连接测试
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
import { loadBehaviorConfig, loadExecConfig, refreshState, saveBehaviorConfig, saveExecConfig, setAuthToken, clearAuthToken, store } from '../store';
import { classifyError, downloadText, formatTime } from '../utils';

/** 适配器版本（与 modules/echotik/adapter capabilities 保持一致） */
const ADAPTER_VERSION = 'echotik-web-adapter/0.1';

/** 远程客户端信息 */
const me = ref<ClientMe | null>(null);
/** 本地身份信息 */
const localInfo = ref({ client_id: null as string | null, registered_at: null as string | null });
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

// ---------------- 激活认证（服务器 auth_users 表内配置） ----------------
/** 激活认证码输入 */
const authTokenEdit = ref('');
/** 验证中 */
const authBusy = ref(false);
/** 切换结果 */
const authResult = ref<string | null>(null);
/** 插件更新检测 */
const updateBusy = ref(false);
const updateResult = ref<{ version: string; download_url: string; notes: string; update_available: boolean } | null>(null);

/**
 * 保存并验证激活认证码；服务端按 token 返回角色（USER/ADMIN）
 */
async function saveAuth(): Promise<void> {
  errorText.value = null;
  const token = authTokenEdit.value.trim();
  if (!token) {
    errorText.value = '请输入激活认证码';
    return;
  }
  authBusy.value = true;
  try {
    await setAuthToken(token);
    await loadMe();
    await refreshState();
    const role = store.state?.role === 'ADMIN' ? '管理员' : '普通用户';
    authResult.value = `激活认证成功：${role}（${store.state?.display_name ?? store.state?.client_id?.slice(0, 8) ?? ''}）`;
    feedback.value = '激活认证已保存。';
  } catch (e) {
    authResult.value = null;
    errorText.value = `激活认证失败：${classifyError(e).text}`;
    authTokenEdit.value = store.authToken ?? '';
  } finally {
    authBusy.value = false;
  }
}

/**
 * 退出授权：清除本机激活认证，插件回到未授权状态
 */
async function logoutAuth(): Promise<void> {
  await clearAuthToken();
  authTokenEdit.value = '';
  authResult.value = '已退出授权。';
  feedback.value = '激活认证已清除。';
}

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

/** 向内置服务查询最新发布版本；Chrome 本地安装插件需手动下载并替换。 */
async function checkPluginUpdate(): Promise<void> {
  updateBusy.value = true;
  errorText.value = null;
  try {
    updateResult.value = await sendMsg('plugin.checkUpdate', undefined);
  } catch (e) {
    errorText.value = `更新检测失败：${classifyError(e).text}`;
  } finally {
    updateBusy.value = false;
  }
}

async function downloadPluginUpdate(): Promise<void> {
  if (!updateResult.value?.download_url) return;
  await browser.tabs.create({ url: updateResult.value.download_url });
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
    exec_config: exec.value,
    behavior_config: behavior.value,
    outbox_pending: dataStats.value.outbox,
    env: env.value,
    debug_logs: debugLogs.value,
  };
  downloadText(`echotik-diagnostics-${Date.now()}.json`, JSON.stringify(diag, null, 2), 'application/json');
  feedback.value = '诊断信息已导出（不含凭证）。';
}

/** 调试日志（最近 100 条） */
const debugLogs = ref<{ t: string; scope: string; msg: string; data?: string }[]>([]);
const debugLoading = ref(false);

/**
 * 刷新调试日志（走 background，读取跨上下文环形缓冲）
 */
async function loadDebugLogs(): Promise<void> {
  debugLoading.value = true;
  try {
    const r = await sendMsg('debug.readLogs', { limit: 100 });
    debugLogs.value = r.items;
  } catch (e) {
    feedback.value = classifyError(e).text;
  } finally {
    debugLoading.value = false;
  }
}

/**
 * 清空调试日志
 */
async function clearDebugLogs(): Promise<void> {
  try {
    await sendMsg('debug.clearLogs', undefined);
    debugLogs.value = [];
    feedback.value = '调试日志已清空。';
  } catch (e) {
    feedback.value = classifyError(e).text;
  }
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
  };
  // 回填当前认证 Token，便于切换或退出
  authTokenEdit.value = (await storageGet('auth_token')) ?? '';
  exec.value = await loadExecConfig();
  behavior.value = await loadBehaviorConfig();
  await Promise.all([loadMe(), checkEnv(), loadTiktokTabs(), loadDataStats(), loadDebugLogs()]);
});
</script>

<template>
  <div>
    <div v-if="errorText" class="alert-bar err">{{ errorText }}</div>
    <div v-if="feedback" class="alert-bar" style="background:#f0fdf4;border-color:#bbf7d0;color:#166534">{{ feedback }}</div>

    <!-- 激活认证卡：服务端 auth_users 表配置，同一凭据跨浏览器共享数据 -->
    <div class="card">
      <h3>激活认证
        <span :class="store.state?.role === 'ADMIN' ? 'badge ok' : 'badge warn'">
          {{ store.state?.role === 'ADMIN' ? '管理员' : store.state?.authorized ? '普通用户' : '未授权' }}
        </span>
      </h3>
      <div class="form-row">
        <label>激活认证</label>
        <input v-model="authTokenEdit" type="password" placeholder="输入激活认证码" @keyup.enter="saveAuth" />
        <button class="act" :disabled="authBusy" @click="saveAuth">{{ authBusy ? '验证中…' : '更新认证' }}</button>
        <button v-if="store.state?.authorized" class="act danger" @click="logoutAuth">退出授权</button>
      </div>
      <p v-if="authResult" class="small muted" style="margin-bottom: 0">{{ authResult }}</p>
    </div>

    <div class="card">
      <h3>插件更新</h3>
      <div class="form-row">
        <label>当前版本</label>
        <span class="mono">{{ browser.runtime.getManifest().version }}</span>
        <button class="act" :disabled="updateBusy" @click="checkPluginUpdate">{{ updateBusy ? '检测中…' : '检测更新' }}</button>
      </div>
      <template v-if="updateResult">
        <p class="small" style="margin-bottom: 4px">
          {{ updateResult.update_available ? `发现新版本 v${updateResult.version}` : '当前已是最新版本' }}
        </p>
        <p v-if="updateResult.notes" class="small muted" style="margin: 0 0 6px">{{ updateResult.notes }}</p>
        <button v-if="updateResult.update_available" class="act" @click="downloadPluginUpdate">下载更新包</button>
        <p v-if="updateResult.update_available" class="small muted" style="margin: 6px 0 0">
          下载后请在 Chrome 扩展程序页手动替换或重新加载插件。
        </p>
      </template>
    </div>

    <!-- 客户端卡 -->
    <div class="card">
      <h3>客户端</h3>
      <div class="kv small" style="display: flex; margin-bottom: 6px">
        <b style="width: 88px; color: #6b7280">client_id</b>
        <span class="mono">{{ localInfo.client_id ?? '未授权' }}</span>
        <button v-if="localInfo.client_id" class="link" @click="copyText(localInfo.client_id!)">复制</button>
      </div>
      <div class="small">名称：{{ me?.display_name ?? store.state?.display_name ?? '—' }}</div>
      <div class="small">角色：{{ store.state?.role === 'ADMIN' ? '管理员' : '普通用户' }}</div>
      <div class="small">扩展版本：{{ me?.extension_version ?? ADAPTER_VERSION }}</div>
      <div class="small">注册时间：{{ formatTime(localInfo.registered_at ?? me?.registered_at) }}</div>
      <div class="small">最后同步：{{ formatTime(me?.last_seen_at) }}</div>
      <div class="form-row" style="margin-top: 8px">
        <label>服务连接</label>
        <button class="act" @click="testConnection">连接测试</button>
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

    <!-- 调试日志：跨上下文环形缓冲，用于排查采集流程卡点 -->
    <div class="card">
      <h3>调试日志</h3>
      <div class="small">最近 {{ debugLogs.length }} 条（最多保留 300 条，跨后台/内容脚本/侧边栏共享）。</div>
      <div class="btn-row" style="flex-wrap: wrap">
        <button class="act" :disabled="debugLoading" @click="loadDebugLogs">{{ debugLoading ? '刷新中…' : '刷新' }}</button>
        <button class="act" @click="clearDebugLogs">清空</button>
      </div>
      <div v-if="debugLogs.length" style="max-height: 260px; overflow: auto; margin-top: 8px; font-family: ui-monospace, monospace; font-size: 11px; line-height: 1.5; background: #0f172a; color: #e2e8f0; border-radius: 6px; padding: 8px">
        <div v-for="(l, i) in debugLogs" :key="i" style="white-space: pre-wrap; word-break: break-all">
          <span style="color: #64748b">{{ l.t.slice(11, 19) }}</span>
          <span style="color: #38bdf8">[{{ l.scope }}]</span>
          <span>{{ l.msg }}</span>
          <span v-if="l.data" style="color: #a5b4fc">{{ l.data }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
