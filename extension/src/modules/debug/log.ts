/**
 * 调试日志（跨上下文可读）
 * - 输出到控制台（`[EchoTik]` 前缀），同时写入 chrome.storage.local 环形缓冲区
 * - 内容脚本 / 后台 / 侧边栏共享同一份日志，便于事后定位“为什么没点击按钮”
 */
import { browser } from 'wxt/browser';

/** 单条日志 */
export interface DebugLogEntry {
  /** ISO 时间 */
  t: string;
  /** 来源：background / tiktok / miaoshou / sidepanel */
  scope: string;
  /** 摘要 */
  msg: string;
  /** 可选补充数据（JSON 字符串，已截断） */
  data?: string;
}

/** 存储键 */
export const DEBUG_LOG_KEY = 'etm_debug_logs';
/** 环形缓冲上限 */
const MAX_ENTRIES = 300;
/** 落盘防抖（毫秒） */
const FLUSH_DELAY_MS = 400;

/** 内存缓冲（仅本上下文新增、尚未落盘的日志） */
let pending: DebugLogEntry[] = [];
/** 落盘防抖中标记 */
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 把待写日志延迟落盘
 * 多个上下文（后台/内容脚本/侧边栏）共享同一存储键，因此采用“读-合并-写”而不是整体覆盖，
 * 避免后写者把前者的日志冲掉
 */
function scheduleFlush(): void {
  if (flushTimer != null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_DELAY_MS);
}

/** 将 pending 合并进存储中的历史日志 */
async function flush(): Promise<void> {
  if (!pending.length) return;
  const batch = pending;
  pending = [];
  try {
    const got = await browser.storage.local.get(DEBUG_LOG_KEY);
    const prev = Array.isArray(got?.[DEBUG_LOG_KEY]) ? (got[DEBUG_LOG_KEY] as DebugLogEntry[]) : [];
    const seen = new Set(prev.map((e) => `${e.t}|${e.scope}|${e.msg}|${e.data ?? ''}`));
    const appended = batch.filter((e) => !seen.has(`${e.t}|${e.scope}|${e.msg}|${e.data ?? ''}`));
    const merged = [...prev, ...appended]
      .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
      .slice(-MAX_ENTRIES);
    await browser.storage.local.set({ [DEBUG_LOG_KEY]: merged });
  } catch {
    // 日志写入失败不影响主流程
  }
}

/**
 * 读取存储中的全部日志（供读取接口使用，包含其他上下文写入的内容）
 */
async function loadFromStorage(): Promise<DebugLogEntry[]> {
  try {
    const got = await browser.storage.local.get(DEBUG_LOG_KEY);
    const arr = got?.[DEBUG_LOG_KEY];
    return Array.isArray(arr) ? (arr as DebugLogEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * 记录一条调试日志
 * @param scope 来源模块
 * @param msg 摘要
 * @param data 可选补充数据（对象会被序列化并截断到 200 字符）
 */
export async function dlog(scope: string, msg: string, data?: unknown): Promise<void> {
  let extra: string | undefined;
  if (data !== undefined) {
    try {
      extra = (typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 200);
    } catch {
      extra = String(data).slice(0, 200);
    }
  }
  const entry: DebugLogEntry = { t: new Date().toISOString(), scope, msg, data: extra };
  // 控制台始终输出，便于在 TikTok 页/后台直接查看
  console.log(`[EchoTik][${scope}] ${msg}${extra ? ` | ${extra}` : ''}`);
  pending.push(entry);
  if (pending.length > MAX_ENTRIES) pending = pending.slice(-MAX_ENTRIES);
  scheduleFlush();
}

/**
 * 读取最近调试日志（合并存储中所有上下文写入的日志）
 * @param limit 条数上限（按时间升序返回）
 */
export async function readDebugLogs(limit = 100): Promise<DebugLogEntry[]> {
  // 先落盘本上下文未写出的日志，保证读到的内容完整
  await flush();
  const all = await loadFromStorage();
  return all.slice(-Math.max(1, limit));
}

/** 清空调试日志 */
export async function clearDebugLogs(): Promise<void> {
  pending = [];
  await browser.storage.local.set({ [DEBUG_LOG_KEY]: [] });
}
