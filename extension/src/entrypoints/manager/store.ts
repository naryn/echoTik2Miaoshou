/**
 * 管理台全局状态 store（简单 reactive 实现，无 pinia）
 * - 与 background 的消息 client（Promise 化封装 + 状态订阅）
 * - 刷新/关闭侧栏不影响批次运行（权威状态在 background/远程）
 * - 筛选预设 CRUD 与执行/行为配置（chrome.storage.local）
 */
import { reactive } from 'vue';
import { browser } from 'wxt/browser';
import { sendMsg } from '@/shared/messaging';
import type {
  BehaviorConfig,
  ExecConfig,
  FilterPreset,
  RuntimePublicState,
} from '@/shared/types';
import { DEFAULT_BEHAVIOR_CONFIG, DEFAULT_EXEC_CONFIG } from '@/shared/types';
import { storageGet, storageSet } from '@/modules/storage';

/** 全局状态 */
export const store = reactive({
  state: null as RuntimePublicState | null,
  loading: true,
  error: null as string | null,
  /** 插件设置中填写的认证 Token（Bearer；为空时整个插件不可用） */
  authToken: null as string | null,
});

/**
 * 初始化 store：拉取一次状态 + 订阅 background 广播（runtime.state.push）
 */
export async function initStore(): Promise<void> {
  // 认证 Token 与运行时状态并行读取
  storageGet('auth_token')
    .then((token) => {
      store.authToken = token;
    })
    .catch(() => {
      store.authToken = null;
    });
  try {
    store.state = await sendMsg('client.getState', undefined);
    store.error = null;
  } catch (e) {
    store.error = (e as Error).message;
  } finally {
    store.loading = false;
  }
  browser.runtime.onMessage.addListener((msg: { type?: string; payload?: RuntimePublicState }) => {
    if (msg.type === 'runtime.state.push' && msg.payload) {
      store.state = msg.payload;
    }
  });
}

/**
 * 保存并验证认证 Token（成功后切换账号身份并刷新状态）
 * @param token 服务端 auth_users 表中的 token
 */
export async function setAuthToken(token: string): Promise<void> {
  const me = await sendMsg('auth.setToken', { token: token.trim() });
  store.authToken = token.trim();
  // auth.setToken 内部已广播，这里再主动拉一次确保侧栏立即更新
  await refreshState();
  store.error = me ? null : store.error;
}

/**
 * 清除认证 Token（退出授权，插件回到不可用状态）
 */
export async function clearAuthToken(): Promise<void> {
  await sendMsg('auth.clear', undefined);
  store.authToken = null;
  await refreshState();
}

/**
 * 主动刷新一次运行时状态
 */
export async function refreshState(): Promise<void> {
  try {
    store.state = await sendMsg('client.getState', undefined);
    store.error = null;
  } catch (e) {
    store.error = (e as Error).message;
  }
}

/**
 * 动作封装：暂停当前批次
 */
export async function pauseRunner(): Promise<void> {
  await sendMsg('runner.pause', undefined);
  await refreshState();
}

/**
 * 动作封装：继续当前批次
 */
export async function resumeRunner(): Promise<void> {
  await sendMsg('runner.resume', undefined);
  await refreshState();
}

/**
 * 动作封装：定位 TikTok 工作页
 */
export async function locateWorkerTab(): Promise<void> {
  await sendMsg('widget.locateWorkerTab', undefined);
}

// ---------------- 筛选预设 CRUD（chrome.storage.local，规范 §3.3） ----------------

/**
 * 读取全部筛选预设
 */
export async function listPresets(): Promise<FilterPreset[]> {
  return storageGet('filter_presets');
}

/**
 * 保存筛选预设（同名覆盖）
 * @param preset 预设
 */
export async function savePreset(preset: FilterPreset): Promise<FilterPreset[]> {
  const all = await storageGet('filter_presets');
  const idx = all.findIndex((p) => p.name === preset.name);
  if (idx >= 0) all[idx] = preset;
  else all.push(preset);
  await storageSet('filter_presets', all);
  return all;
}

/**
 * 删除筛选预设
 * @param name 预设名
 */
export async function deletePreset(name: string): Promise<FilterPreset[]> {
  const all = (await storageGet('filter_presets')).filter((p) => p.name !== name);
  await storageSet('filter_presets', all);
  return all;
}

// ---------------- 执行/行为配置（规范 §3.7） ----------------

/**
 * 读取执行参数（带默认值）
 */
export async function loadExecConfig(): Promise<ExecConfig> {
  return { ...DEFAULT_EXEC_CONFIG, ...(await storageGet('exec_config')) };
}

/**
 * 保存执行参数
 * @param cfg 新配置
 */
export async function saveExecConfig(cfg: ExecConfig): Promise<void> {
  await storageSet('exec_config', cfg);
}

/**
 * 读取行为配置（带默认值）
 */
export async function loadBehaviorConfig(): Promise<BehaviorConfig> {
  return { ...DEFAULT_BEHAVIOR_CONFIG, ...(await storageGet('behavior_config')) };
}

/**
 * 保存行为配置
 * @param cfg 新配置
 */
export async function saveBehaviorConfig(cfg: BehaviorConfig): Promise<void> {
  await storageSet('behavior_config', cfg);
}
