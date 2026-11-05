/**
 * EchoTik 页面 content script（ISOLATED world）
 * - 登录态/域名检测
 * - 通过 window.postMessage 与 MAIN world 桥通信（nonce 配对 + origin 校验 + 超时）
 * - 向 background 暴露榜单分页抓取消息接口
 */
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import {
  isAllowedEchoTikPath,
  PAGE_BRIDGE,
  type PageBridgeRequest,
  type PageBridgeResponse,
} from '@/shared/types/messages';
import { ERROR_CODES, type RankingQuery } from '@/shared/types';
import { wrapHandler } from '@/shared/messaging';

export default defineContentScript({
  matches: ['https://echotik.live/*', 'https://*.echotik.live/*'],
  runAt: 'document_idle',
  main() {
    // 通知 background content script 就绪
    void browser.runtime
      .sendMessage({ type: 'cs.contentReady', payload: { site: 'echotik', url: location.href } })
      .catch(() => undefined);

    browser.runtime.onMessage.addListener((msg: { type?: string; payload?: unknown }, _sender, sendResponse) => {
      void route(msg).then(sendResponse);
      return true;
    });

    /**
     * 路由 background 下发的消息
     * @param msg 消息信封
     */
    async function route(msg: { type?: string; payload?: unknown }): Promise<unknown> {
      switch (msg.type) {
        case 'echotik.checkLogin':
          return wrapHandler<'echotik.checkLogin'>(async () => checkLogin())(undefined, null);
        case 'echotik.readPageSelection':
          return wrapHandler<'echotik.readPageSelection'>(async () => readPageSelection())(undefined, null);
        case 'echotik.fetchApi':
          return wrapHandler<'echotik.fetchApi'>(async (payload) => {
            return pageFetch(payload.path, payload.params, payload.lang);
          })(msg.payload as { path: string; params: Record<string, string | number>; lang?: 'zh-CN' | 'en' }, null);
        default:
          return { ok: false, error: { code: 'UNKNOWN_MESSAGE', message: String(msg.type) } };
      }
    }

    /**
     * 检测 EchoTik 登录态与域名（组合信号：域名 + 登录入口/用户控件证据）
     */
    function checkLogin(): { loggedIn: boolean; evidence: string } {
      if (!location.hostname.endsWith('echotik.live')) {
        return { loggedIn: false, evidence: `非 echotik.live 域: ${location.hostname}` };
      }
      // 页面证据：存在"登录/注册"入口 → 未登录；存在用户头像/退出入口 → 已登录
      const bodyText = (document.body?.innerText ?? '').slice(0, 4000);
      const hasLoginEntry = /登录|注册|Sign in|Log in/i.test(bodyText);
      const hasUserWidget =
        document.querySelector('[class*="avatar"], [class*="user-info"], [class*="logout"]') != null;
      if (hasUserWidget && !hasLoginEntry) {
        return { loggedIn: true, evidence: '发现用户控件且无登录入口' };
      }
      if (hasLoginEntry) {
        return { loggedIn: false, evidence: '页面存在登录/注册入口' };
      }
      return { loggedIn: true, evidence: '未发现登录入口（弱证据）' };
    }

    /**
     * 读取当前页面 URL 中的榜单筛选条件（time_type/time_range/order 等）
     */
    function readPageSelection(): Partial<RankingQuery> {
      const sp = new URLSearchParams(location.search);
      const out: Partial<RankingQuery> = {};
      const timeType = sp.get('time_type');
      if (timeType) out.rankingType = timeType;
      const timeRange = sp.get('time_range');
      if (timeRange) out.periodStart = timeRange;
      const order = sp.get('order');
      if (order) out.sortBy = order;
      const cats = sp.get('product_categories');
      if (cats) out.categoryId = cats;
      return out;
    }

    /**
     * 经 MAIN world 桥发起同源接口请求（nonce 配对 + 超时 + 白名单）
     * @param path 接口路径（白名单内）
     * @param params query 参数
     * @param lang 响应语言（默认中文）
     */
    function pageFetch(
      path: string,
      params: Record<string, string | number>,
      lang?: 'zh-CN' | 'en',
    ): Promise<unknown> {
      if (!isAllowedEchoTikPath(path)) {
        return Promise.reject(
          Object.assign(new Error(`接口路径不在白名单: ${path}`), { code: ERROR_CODES.ECHOTIK_BAD_RESPONSE }),
        );
      }
      const nonce = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          window.removeEventListener('message', listener);
          reject(Object.assign(new Error('EchoTik 页面桥请求超时'), { code: ERROR_CODES.TIMEOUT }));
        }, 45_000);
        const listener = (event: MessageEvent) => {
          if (event.origin !== location.origin) return;
          const resp = event.data as PageBridgeResponse;
          if (!resp || resp.type !== PAGE_BRIDGE.RESPONSE || resp.nonce !== nonce) return;
          clearTimeout(timer);
          window.removeEventListener('message', listener);
          if (!resp.ok) {
            // HTML 响应时桥会回传 "原因|状态码|最终URL|正文摘要"
            const [kind, status, finalUrl, ...rest] = (resp.error ?? '').split('|');
            const snippet = rest.join('|');
            if (kind === 'PERMISSION_LIMIT') {
              // 会员/访客权限限制：登录态正常，仅当前账号可查看/翻页的数据深度受限
              reject(
                Object.assign(
                  new Error(`EchoTik 会员权限限制：当前账号仅能查看有限榜单数据（HTTP ${status}）`),
                  { code: ERROR_CODES.ECHOTIK_PERMISSION_LIMIT },
                ),
              );
              return;
            }
            if (kind === 'UNAUTHORIZED' || kind === 'LOGIN_REQUIRED') {
              reject(
                Object.assign(new Error('EchoTik 未登录或登录已失效，请在 echotik.live 登录后重试'), {
                  code: ERROR_CODES.ECHOTIK_UNAUTHORIZED,
                }),
              );
              return;
            }
            if (kind === 'HTML_RESPONSE') {
              reject(
                Object.assign(
                  new Error(`EchoTik 返回网页而非数据(HTTP ${status}，${finalUrl})：${snippet || '无正文摘要'}`),
                  { code: ERROR_CODES.ECHOTIK_BAD_RESPONSE },
                ),
              );
              return;
            }
            reject(Object.assign(new Error(resp.error ?? 'EchoTik 请求失败'), { code: ERROR_CODES.ECHOTIK_NETWORK }));
            return;
          }
          resolve(resp.data);
        };
        window.addEventListener('message', listener);
        const req: PageBridgeRequest = { type: PAGE_BRIDGE.REQUEST, nonce, path, params, lang };
        window.postMessage(req, location.origin);
      });
    }
  },
});
