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

/** 内存缓冲（已加载的历史 + 新日志） */
let buffer: DebugLogEntry[] = [];
/** 是否已从存储加载 */
let loaded = false;
/** 待落盘标记 */
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** 把待写日志延迟落盘，避免每条日志都读写存储 */
function scheduleFlush(): void {
  if (flushTimer != null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void browser.storage.local.set({ [DEBUG_LOG_KEY]: buffer.slice(-MAX_ENTRIES) });
  }, FLUSH_DELAY_MS);
}

/** 首次使用时加载历史日志（失败则从空缓冲开始，不影响主流程） */
async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const got = await browser.storage.local.get(DEBUG_LOG_KEY);
    const arr = got?.[DEBUG_LOG_KEY];
    if (Array.isArray(arr)) buffer = arr.slice(-MAX_ENTRIES);
  } catch {
    buffer = [];
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
  await ensureLoaded();
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer = buffer.slice(-MAX_ENTRIES);
  scheduleFlush();
}

/**
 * 读取最近调试日志
 * @param limit 条数上限（按时间升序返回）
 */
export async function readDebugLogs(limit = 100): Promise<DebugLogEntry[]> {
  await ensureLoaded();
  return buffer.slice(-Math.max(1, limit));
}

/** 清空调试日志 */
export async function clearDebugLogs(): Promise<void> {
  buffer = [];
  loaded = true;
  await browser.storage.local.set({ [DEBUG_LOG_KEY]: [] });
}
