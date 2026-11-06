/**
 * FastMoss MAIN world 请求桥（页面上下文）
 *
 * 职责：
 * 1. 挂钩页面的 fetch / XMLHttpRequest，记录榜单相关接口调用（URL 模板 + 请求体 + 响应顶层字段）；
 * 2. 响应 ISOLATED world 的请求，按记录的模板在页面上下文回放请求（自动携带页面登录态）；
 * 3. 严格校验：只接受同源消息、固定协议 + nonce、只允许 fastmoss 域下的相对路径。
 *
 * 为什么需要捕获：FastMoss 未公开榜单接口，路径/参数随前端版本变化，
 * 直接写死接口会在版本升级后失效；捕获真实请求再回放，可自适应。
 */
import { defineContentScript } from 'wxt/utils/define-content-script';
import {
  FAST_MOSS_BRIDGE,
  type FastMossBridgeRequest,
  type FastMossBridgeResponse,
  type FastMossCapturedCall,
} from '@/shared/types/messages';

/** 最多保留的捕获记录数 */
const MAX_CAPTURED = 30;
/** 捕获记录的保留时长（毫秒） */
const CAPTURE_TTL_MS = 10 * 60 * 1000;
/** 响应体最大记录长度（避免占用过多内存） */
const MAX_BODY_CHARS = 2_000_000;

/** 已捕获的接口调用（页面内存，随页面刷新清空） */
const captured: FastMossCapturedCall[] = [];

/**
 * 记录一次接口调用
 * @param call 调用信息
 */
function record(call: FastMossCapturedCall): void {
  const cutoff = Date.now() - CAPTURE_TTL_MS;
  while (captured.length && new Date(captured[0]!.at).getTime() < cutoff) captured.shift();
  captured.push(call);
  if (captured.length > MAX_CAPTURED) captured.splice(0, captured.length - MAX_CAPTURED);
}

/**
 * 判断 URL 是否值得捕获（榜单/商品列表类接口，排除静态资源与埋点）
 * @param url 绝对 URL
 */
function isInteresting(url: string): boolean {
  if (/\.(png|jpg|jpeg|webp|gif|svg|css|woff2?|ttf|ico)(\?|$)/i.test(url)) return false;
  if (/collect|track|log|report|beacon|sentry|analytics/i.test(url)) return false;
  return /rank|ranking|product|goods|item|list|hot|sale|shop|search/i.test(url);
}

/**
 * 读取响应 JSON 的顶层字段名（用于诊断结构，不保留完整响应）
 * @param data 解析后的响应
 */
function topKeysOf(data: unknown): string[] | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const obj = data as Record<string, unknown>;
  const inner = obj.data && typeof obj.data === 'object' ? (obj.data as Record<string, unknown>) : obj;
  return Object.keys(inner).slice(0, 20);
}

/**
 * 只保留签名/鉴权相关的请求头：FastMoss 前端会给接口加 _time/cnonce/fm-sign 等签名头，
 * 回放时必须带上，否则会被风控拦截；同时避免复制 Cookie/Host 等 fetch 禁改头。
 */
const SIGN_HEADER_ALLOWLIST = [
  '_time',
  'cnonce',
  'fm-sign',
  'fm-sig',
  'x-sign',
  'x-signature',
  'x-requested-with',
  'authorization',
  'accept',
  'accept-language',
  'content-type',
  // 站点自定义头：实测接口会校验 region / lang / source
  'region',
  'lang',
  'source',
];

/**
 * 从请求头集合中挑出允许回放的签名头
 * @param headers 原始请求头（HeadersInit 或键值对）
 */
function pickSignHeaders(headers?: HeadersInit | Record<string, string>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  if (!headers) return undefined;
  const append = (k: string, v: string): void => {
    if (SIGN_HEADER_ALLOWLIST.includes(k.toLowerCase())) out[k] = v;
  };
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((v, k) => append(k, v));
  } else if (Array.isArray(headers)) {
    for (const [k, v] of headers) append(String(k), String(v));
  } else {
    for (const [k, v] of Object.entries(headers)) append(k, String(v));
  }
  return Object.keys(out).length ? out : undefined;
}

/** 标记是否已挂钩（防止重复注入导致多重记录） */
let installed = false;

/**
 * 挂钩 fetch 与 XHR
 */
function installHooks(): void {
  if (installed) return;
  installed = true;

  const origFetch = window.fetch.bind(window);
  window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit) {
    const res = await origFetch(input, init);
    try {
      const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const abs = new URL(rawUrl, location.href).href;
      if (isInteresting(abs)) {
        const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET') ?? 'GET')
          .toUpperCase() as 'GET' | 'POST';
        const bodyText = typeof init?.body === 'string' ? init.body : undefined;
        // 记录签名头（fetch 的 init.headers 或 Request.headers）
        const headers = pickSignHeaders(
          init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined),
        );
        // 克隆响应避免消费原响应流
        const clone = res.clone();
        void clone.text().then((text) => {
          let data: unknown;
          try {
            data = JSON.parse(text.slice(0, MAX_BODY_CHARS));
          } catch {
            return;
          }
          record({
            method,
            url: abs,
            body: bodyText,
            headers,
            topKeys: topKeysOf(data),
            status: res.status,
            at: new Date().toISOString(),
          });
        });
      }
    } catch {
      // 捕获失败不影响页面本身
    }
    return res;
  } as typeof window.fetch;

  const OrigXHR = window.XMLHttpRequest;
  const origOpen = OrigXHR.prototype.open;
  const origSend = OrigXHR.prototype.send;
  const origSetHeader = OrigXHR.prototype.setRequestHeader;

  /** XHR 元信息：记录 URL / method / 签名头（axios 在 send 前逐个 setRequestHeader） */
  interface XhrMeta {
    method: string;
    url: string;
    headers: Record<string, string>;
  }

  /**
   * 记录单个请求头（只保留签名相关）
   */
  OrigXHR.prototype.setRequestHeader = function patchedSetHeader(this: XMLHttpRequest, name: string, value: string) {
    const meta = (this as XMLHttpRequest & { __etm?: XhrMeta }).__etm;
    if (meta && SIGN_HEADER_ALLOWLIST.includes(String(name).toLowerCase())) {
      meta.headers[String(name)] = String(value);
    }
    return origSetHeader.call(this, name, value);
  };

  OrigXHR.prototype.open = function patchedOpen(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    (this as XMLHttpRequest & { __etm?: XhrMeta }).__etm = {
      method: method.toUpperCase(),
      url: new URL(String(url), location.href).href,
      headers: {},
    };
    // @ts-expect-error 透传原生参数
    return origOpen.call(this, method, url, ...rest);
  };
  OrigXHR.prototype.send = function patchedSend(this: XMLHttpRequest, body?: Document | BodyInit | null) {
    const meta = (this as XMLHttpRequest & { __etm?: XhrMeta }).__etm;
    if (meta && isInteresting(meta.url)) {
      this.addEventListener('load', () => {
        try {
          const data = JSON.parse(this.responseText.slice(0, MAX_BODY_CHARS));
          record({
            method: meta.method === 'POST' ? 'POST' : 'GET',
            url: meta.url,
            body: typeof body === 'string' ? body : undefined,
            headers: Object.keys(meta.headers).length ? meta.headers : undefined,
            topKeys: topKeysOf(data),
            status: this.status,
            at: new Date().toISOString(),
          });
        } catch {
          // 非 JSON 响应忽略
        }
      });
    }
    return origSend.call(this, body as XMLHttpRequestBodyInit | Document | null);
  };
}

/**
 * 回传消息给 ISOLATED world（同源 window.postMessage）
 * @param res 响应体
 */
function post(res: FastMossBridgeResponse): void {
  window.postMessage(res, location.origin);
}

/**
 * 在页面上下文回放请求
 * @param req 桥请求
 */
async function replay(req: FastMossBridgeRequest): Promise<void> {
  const nonce = req.nonce;
  try {
    const target = new URL(String(req.url ?? ''), location.href);
    // 安全边界：只允许本站路径，避免被诱导请求第三方
    if (target.origin !== location.origin) {
      post({ type: FAST_MOSS_BRIDGE.FETCH_RESULT, nonce, ok: false, error: 'ORIGIN_NOT_ALLOWED' });
      return;
    }
    const res = await fetch(target.href, {
      method: req.method ?? 'GET',
      credentials: 'include',
      headers: { 'content-type': 'application/json', ...(req.headers ?? {}) },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text.slice(0, MAX_BODY_CHARS));
    } catch {
      // 非 JSON 时回传原文，由上层判定
    }
    post({ type: FAST_MOSS_BRIDGE.FETCH_RESULT, nonce, ok: res.ok, data, status: res.status });
  } catch (e) {
    post({ type: FAST_MOSS_BRIDGE.FETCH_RESULT, nonce, ok: false, error: (e as Error).message });
  }
}

export default defineContentScript({
  matches: ['https://www.fastmoss.com/*', 'https://*.fastmoss.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    installHooks();
    window.addEventListener('message', (event: MessageEvent) => {
      if (event.origin !== location.origin) return;
      const req = event.data as FastMossBridgeRequest;
      if (!req || typeof req.nonce !== 'string' || req.nonce.length < 8) return;
      if (req.type === FAST_MOSS_BRIDGE.LIST) {
        post({
          type: FAST_MOSS_BRIDGE.LIST_RESULT,
          nonce: req.nonce,
          ok: true,
          data: captured.slice(-MAX_CAPTURED),
        });
        return;
      }
      if (req.type === FAST_MOSS_BRIDGE.FETCH) void replay(req);
    });
  },
});
