/**
 * EchoTik MAIN world 最小请求桥（规范 §2/§10）
 * - 固定协议 + nonce + 严格 origin 校验
 * - 只允许白名单接口路径（/api/v1/data/products*），不接受任意 URL/任意 JS 执行
 * - 在页面上下文发起同源 fetch（携带页面已有登录会话），结果回传 ISOLATED world
 */
import { defineContentScript } from 'wxt/utils/define-content-script';
import {
  isAllowedEchoTikPath,
  PAGE_BRIDGE,
  type PageBridgeRequest,
  type PageBridgeResponse,
} from '@/shared/types/messages';

export default defineContentScript({
  // 同时覆盖 www.echotik.live 等子域：ISOLATED 脚本匹配子域，若 MAIN 缺失会导致桥请求超时
  matches: ['https://echotik.live/*', 'https://*.echotik.live/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    window.addEventListener('message', (event: MessageEvent) => {
      // 严格 origin 校验：只接受同源消息
      if (event.origin !== window.location.origin) return;
      const req = event.data as PageBridgeRequest;
      if (!req || req.type !== PAGE_BRIDGE.REQUEST) return;
      if (typeof req.nonce !== 'string' || req.nonce.length < 8) return;
      if (!isAllowedEchoTikPath(req.path)) {
        post({
          type: PAGE_BRIDGE.RESPONSE,
          nonce: req.nonce,
          ok: false,
          error: 'PATH_NOT_ALLOWED',
        });
        return;
      }
      void handleRequest(req);
    });

    /**
     * 执行同源 fetch 并回传结果
     * @param req 桥请求
     */
    async function handleRequest(req: PageBridgeRequest): Promise<void> {
      try {
        const url = new URL(req.path, window.location.origin);
        for (const [k, v] of Object.entries(req.params ?? {})) {
          url.searchParams.set(k, String(v));
        }
        const resp = await fetch(url.toString(), {
          method: 'GET',
          credentials: 'include',
          // x-lang: zh-CN 让 EchoTik 接口返回中文字段（类目 label、商品 category 等），与 EchoTik 中文站点一致
          headers:
            req.lang === 'en'
              ? { Accept: 'application/json' }
              : { Accept: 'application/json', 'x-lang': 'zh-CN' },
        });
        if (resp.status === 401 || resp.status === 403) {
          post({ type: PAGE_BRIDGE.RESPONSE, nonce: req.nonce, ok: false, status: resp.status, error: 'UNAUTHORIZED' });
          return;
        }
        const text = await resp.text();
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          // 接口返回网页而非 JSON：区分会员套餐限制（免费/访客翻页到上限会被拦截）
          // 与真正的未登录，前者登录态正常，不应提示重新登录
          const hint = /member plan|member|会员|Visitor/i.test(text)
            ? 'PERMISSION_LIMIT'
            : /登录|注册|sign in|log in/i.test(text)
              ? 'LOGIN_REQUIRED'
              : 'HTML_RESPONSE';
          // 附带状态码、最终 URL 与正文摘要，便于定位是权限页、风控页还是 404 回落
          const snippet = text
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 160);
          post({
            type: PAGE_BRIDGE.RESPONSE,
            nonce: req.nonce,
            ok: false,
            status: resp.status,
            error: `${hint}|${resp.status}|${resp.url}|${snippet}`,
          });
          return;
        }
        post({ type: PAGE_BRIDGE.RESPONSE, nonce: req.nonce, ok: true, status: resp.status, data });
      } catch (e) {
        post({
          type: PAGE_BRIDGE.RESPONSE,
          nonce: req.nonce,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    /**
     * 回传响应（带 nonce，仅发回同源）
     * @param resp 桥响应
     */
    function post(resp: PageBridgeResponse): void {
      window.postMessage(resp, window.location.origin);
    }
  },
});
