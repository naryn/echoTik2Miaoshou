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
const FAST_MOSS_SIGN_SALT = 'LAA6edGHBkcc3eTiOIRfg89bu9ODA6PB';

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
 * FastMoss bundle uses CryptoJS MD5. 采用小型自包含实现，避免把页面 bundle
 * 的私有 webpack runtime 作为扩展依赖。只用于生成当前同源请求的 fm-sign。
 */
function md5(input: string): string {
  const rotate = (v: number, n: number) => (v << n) | (v >>> (32 - n));
  const add = (x: number, y: number) => (((x & 0xffff) + (y & 0xffff)) + (((x >>> 16) + (y >>> 16)) << 16)) | 0;
  const cmn = (q: number, a: number, b: number, x: number, s: number, t: number) => add(rotate(add(add(a, q), add(x, t)), s), b);
  const ff = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) => cmn((b & c) | (~b & d), a, b, x, s, t);
  const gg = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) => cmn((b & d) | (c & ~d), a, b, x, s, t);
  const hh = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) => cmn(b ^ c ^ d, a, b, x, s, t);
  const ii = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) => cmn(c ^ (b | ~d), a, b, x, s, t);
  const bytes = new TextEncoder().encode(input);
  const length = bytes.length;
  const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
  padded.set(bytes); padded[length] = 0x80;
  const bits = length * 8;
  for (let i = 0; i < 8; i++) padded[padded.length - 8 + i] = (bits >>> (i * 8)) & 0xff;
  let a0 = 1732584193; let b0 = -271733879; let c0 = -1732584194; let d0 = 271733878;
  for (let o = 0; o < padded.length; o += 64) {
    const x = Array.from({ length: 16 }, (_, i) => padded[o + i * 4]! | (padded[o + i * 4 + 1]! << 8) | (padded[o + i * 4 + 2]! << 16) | (padded[o + i * 4 + 3]! << 24));
    let [a, b, c, d] = [a0, b0, c0, d0];
    const r1 = [7, 12, 17, 22], r2 = [5, 9, 14, 20], r3 = [4, 11, 16, 23], r4 = [6, 10, 15, 21];
    for (let i = 0; i < 64; i++) { let next: number; if (i < 16) next = ff(a, b, c, d, x[i]!, r1[i % 4]!, [0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821][i]!); else if (i < 32) next = gg(a, b, c, d, x[(5 * i + 1) % 16]!, r2[i % 4]!, [0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a][i-16]!); else if (i < 48) next = hh(a, b, c, d, x[(3 * i + 5) % 16]!, r3[i % 4]!, [0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665][i-32]!); else next = ii(a, b, c, d, x[(7 * i) % 16]!, r4[i % 4]!, [0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391][i-48]!); [a, b, c, d] = [d, next, b, c]; }
    a0 = add(a0, a); b0 = add(b0, b); c0 = add(c0, c); d0 = add(d0, d);
  }
  return [a0, b0, c0, d0].flatMap(v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]).map(v => v.toString(16).padStart(2, '0')).join('');
}

function fastMossSignature(params: URLSearchParams, bodyText = ''): string {
  // FastMoss 会在每一组已排序的 query 参数之后追加 salt，而不是在整个
  // 参数串尾部只追加一次。两者生成的 fm-sign 不同，后者会被接口判为风控请求。
  const source = [...params.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${k}${v}${FAST_MOSS_SIGN_SALT}`)
    .join('');
  const digest = md5(source + bodyText);
  let result = '';
  for (let left = 0, right = digest.length - 1; left < right; left++, right--) result += (parseInt(digest[left]!, 16) ^ parseInt(digest[right]!, 16)).toString(16);
  return result + digest.slice(Math.ceil(digest.length / 2));
}

/**
 * FastMoss 还会通过页面运行时注入的 __SIG__ 生成 fm-sig。该值不是固定算法，
 * 必须复用当前已登录页面的签名器；缺失时接口会返回 MSG_SAFE_0001。
 */
function fastMossRuntimeSignature(pathWithQuery: string): string | undefined {
  try {
    const signer = (globalThis as typeof globalThis & {
      __SIG__?: { gen?: (url: string, payload: Record<string, string>) => string };
    }).__SIG__;
    const value = signer?.gen?.(pathWithQuery, { source: 'pc' });
    return typeof value === 'string' && value ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 对齐 FastMoss axios 的 query serializer。URLSearchParams 会把逗号编码为
 * %2C，而站点的 fm-sig 会对实际发送的、保留逗号的 URL 字符串签名。
 */
function fastMossPathWithQuery(target: URL): string {
  const encode = (value: string) => encodeURIComponent(value)
    .replace(/%20/g, '+')
    .replace(/[!'()*~]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const query = [...target.searchParams.entries()]
    .map(([key, value]) => `${key}=${encode(value)}`)
    .join('&');
  return query ? `${target.pathname}?${query}` : target.pathname;
}

/** FastMoss 自身的 axios 在浏览器中使用 XMLHttpRequest；回放时保持同一传输方式。 */
function requestByXhr(
  method: string,
  pathWithQuery: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ ok: boolean; status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, pathWithQuery, true);
    xhr.withCredentials = true;
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, text: xhr.responseText });
    xhr.onerror = () => reject(new Error('FAST_MOSS_XHR_NETWORK_ERROR'));
    xhr.ontimeout = () => reject(new Error('FAST_MOSS_XHR_TIMEOUT'));
    xhr.timeout = 50_000;
    xhr.send(body);
  });
}

/**
 * 优先调用 FastMoss 页面已加载的 Axios 客户端。它的请求拦截器负责最新的
 * fm-sign、fm-sig、Cookie region 与参数序列化，避免扩展复刻签名细节后漂移。
 */
async function requestByNativeFastMossClient(
  method: string,
  target: URL,
  body: unknown,
): Promise<{ ok: boolean; status: number; text: string } | null> {
  try {
    const chunk = (window as typeof window & { webpackChunk_N_E?: unknown[] }).webpackChunk_N_E;
    if (!Array.isArray(chunk)) return null;
    let webpackRequire: {
      m: Record<string, { toString(): string }>;
      (id: string): { ZP?: { request?: (config: Record<string, unknown>) => Promise<unknown> } };
    } | undefined;
    chunk.push([[`tk-fastmoss-${Date.now()}`], {}, (runtime: typeof webpackRequire) => { webpackRequire = runtime; }]);
    if (!webpackRequire) return null;
    const clientModuleId = Object.keys(webpackRequire.m).find((id) => {
      const source = webpackRequire!.m[id]?.toString() ?? '';
      return source.includes('fm-sign') && source.includes('fm-sig') && source.includes('withCredentials');
    });
    if (!clientModuleId) return null;
    const request = webpackRequire(clientModuleId).ZP?.request;
    if (!request) return null;
    const data = await request({
      method: method.toLowerCase(),
      url: target.pathname,
      params: Object.fromEntries(target.searchParams.entries()),
      ...(body === undefined ? {} : { data: body }),
    });
    return { ok: true, status: 200, text: JSON.stringify(data) };
  } catch {
    // 页面 bundle 变更或客户端暂未加载时，使用下方同源 XHR 兼容回退。
    return null;
  }
}

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
    // FastMoss 的 axios 拦截器会为所有 API 请求附加这三个参数和 fm-sign。
    // SSR 榜单首屏没有浏览器请求可捕获时，采集器也能安全地从同源页面发起请求。
    if (target.pathname.startsWith('/api/')) {
      if (!target.searchParams.has('_time')) target.searchParams.set('_time', String(Math.floor(Date.now() / 1000)));
      if (!target.searchParams.has('cnonce')) target.searchParams.set('cnonce', String(Math.floor(10_000_000 + Math.random() * 90_000_000)));
    }
    const serializedBody = req.body === undefined ? undefined : JSON.stringify(req.body);
    const region = target.searchParams.get('region') ?? 'US';
    const language = /^\/(zh)(\/|$)/.test(location.pathname) ? 'ZH_CN' : 'EN_US';
    const pathWithQuery = fastMossPathWithQuery(target);
    const signedHeaders: Record<string, string> = target.pathname.startsWith('/api/')
      ? {
        Accept: 'application/json, text/plain, */*',
        region,
        lang: language,
        source: 'pc',
        'fm-sign': fastMossSignature(target.searchParams, serializedBody ?? ''),
      }
      : {};
    if (target.pathname.startsWith('/api/')) {
      const runtimeSignature = fastMossRuntimeSignature(pathWithQuery);
      if (runtimeSignature) signedHeaders['fm-sig'] = runtimeSignature;
    }
    const method = req.method ?? 'GET';
    // 捕获模板中的 fm-sign / fm-sig 绑定了当时的 _time、cnonce，重放时已失效。
    // 不能让它们覆盖上面按本次 URL 生成的签名；其余普通头仍可透传。
    const replayHeaders = Object.fromEntries(
      Object.entries(req.headers ?? {}).filter(([name]) => ![
        'fm-sign', 'fm-sig', 'region', 'lang', 'source', 'content-type', 'accept',
      ].includes(name.toLowerCase())),
    );
    const headers = {
      ...replayHeaders,
      ...signedHeaders,
      ...(serializedBody ? { 'content-type': 'application/json' } : {}),
    };
    const nativeResult = target.pathname.startsWith('/api/')
      ? await requestByNativeFastMossClient(method, target, req.body)
      : null;
    const res = nativeResult ?? (target.pathname.startsWith('/api/')
      ? await requestByXhr(method, pathWithQuery, headers, serializedBody)
      : await (async () => {
        const response = await fetch(pathWithQuery, { method, credentials: 'include', headers, body: serializedBody });
        return { ok: response.ok, status: response.status, text: await response.text() };
      })());
    const text = res.text;
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
