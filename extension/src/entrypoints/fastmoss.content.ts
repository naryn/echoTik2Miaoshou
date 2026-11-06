/**
 * FastMoss 页面 content script（ISOLATED world）
 *
 * 为 background 提供三个能力：
 * - 读取页面捕获到的榜单接口调用（供适配器回放模板）
 * - 在页面上下文回放请求（经 MAIN world 桥，携带登录态）
 * - 读取页面 URL 中的筛选条件、探测登录状态
 */
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { wrapHandler } from '@/shared/messaging';
import { dlog } from '@/modules/debug/log';
import {
  FAST_MOSS_BRIDGE,
  type FastMossBridgeRequest,
  type FastMossBridgeResponse,
  type FastMossCapturedCall,
} from '@/shared/types/messages';
import type { RankingQuery } from '@/shared/types';

export default defineContentScript({
  matches: ['https://www.fastmoss.com/*', 'https://*.fastmoss.com/*'],
  runAt: 'document_idle',
  main() {
    void browser.runtime
      .sendMessage({ type: 'cs.contentReady', payload: { site: 'fastmoss', url: location.href } })
      .catch(() => undefined);

    browser.runtime.onMessage.addListener((msg: { type?: string; payload?: unknown }, _sender, sendResponse) => {
      void route(msg).then(sendResponse);
      return true;
    });

    /**
     * 路由 background 下发消息
     * @param msg 消息信封
     */
    async function route(msg: { type?: string; payload?: unknown }): Promise<unknown> {
      switch (msg.type) {
        case 'fastmoss.readCapturedCalls':
          return wrapHandler<'fastmoss.readCapturedCalls'>(async () => {
            const calls = await bridge<FastMossCapturedCall[]>({ type: FAST_MOSS_BRIDGE.LIST });
            return { calls };
          })(undefined, null);
        case 'fastmoss.fetchApi':
          return wrapHandler<'fastmoss.fetchApi'>(async (payload) => {
            // MAIN world 回放后直接回传解析后的 JSON（不额外包一层 data）
            return bridge<unknown>({
              type: FAST_MOSS_BRIDGE.FETCH,
              method: payload.method ?? 'GET',
              url: payload.path,
              body: payload.body,
              headers: payload.headers,
            });
          })(msg.payload as { path: string; params?: Record<string, string | number>; method?: 'GET' | 'POST'; body?: unknown; headers?: Record<string, string> }, null);
        case 'fastmoss.readPageSelection':
          return wrapHandler<'fastmoss.readPageSelection'>(async () => readPageSelection())(undefined, null);
        case 'fastmoss.checkLogin':
          return wrapHandler<'fastmoss.checkLogin'>(async () => checkLogin())(undefined, null);
        default:
          return { ok: false, error: { code: 'UNKNOWN_MESSAGE', message: String(msg.type) } };
      }
    }

    /**
     * 通过 window.postMessage 桥与 MAIN world 通信
     * @param req 桥请求（nonce 自动生成）
     * @param timeoutMs 超时
     */
    function bridge<T>(req: Omit<FastMossBridgeRequest, 'nonce'>, timeoutMs = 20_000): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const expected: FastMossBridgeResponse['type'] =
          req.type === FAST_MOSS_BRIDGE.LIST ? FAST_MOSS_BRIDGE.LIST_RESULT : FAST_MOSS_BRIDGE.FETCH_RESULT;
        const timer = setTimeout(() => {
          cleanup();
          reject(Object.assign(new Error('FastMoss 页面桥超时（MAIN world 可能未注入）'), { code: 'RANKING_SOURCE_BAD_RESPONSE' }));
        }, timeoutMs);
        const onMessage = (event: MessageEvent): void => {
          if (event.origin !== location.origin) return;
          const data = event.data as FastMossBridgeResponse;
          if (!data || data.type !== expected || data.nonce !== nonce) return;
          cleanup();
          if (!data.ok) {
            reject(Object.assign(new Error(data.error ?? 'FastMoss 请求失败'), { code: 'RANKING_SOURCE_BAD_RESPONSE' }));
            return;
          }
          resolve(data.data as T);
        };
        const cleanup = (): void => {
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
        };
        window.addEventListener('message', onMessage);
        window.postMessage({ ...req, nonce }, location.origin);
      });
    }

    /**
     * 读取页面 URL 中的筛选条件（FastMoss 筛选主要靠 query 参数）
     * 实测：榜单页路径区分榜单（saleslist 畅销 / newProducts 新品 / hotlist 热销），
     * query 中 date_type=1/2/3 表示日/周/月，date_value 为周期值
     */
    function readPageSelection(): Partial<RankingQuery> {
      const sp = new URL(location.href).searchParams;
      const pick = (...keys: string[]): string | undefined => {
        for (const k of keys) {
          const v = sp.get(k);
          if (v) return v;
        }
        return undefined;
      };
      const region = pick('region', 'country', 'countryCode', 'market');
      const dateTypeRaw = pick('date_type', 'dateType');
      const periodRaw = pick('period', 'time_type', 'timeType', 'dateRange', 'date_value', 'dateValue');
      // 分类：页面用 l1_cid / l2_cid / l3_cid，其中 l1_cid=all 表示全部分类
      const categoryRaw = pick('l3_cid', 'l2_cid', 'l1_cid', 'category_id', 'categoryId', 'cate_id', 'cateId', 'category');
      const categoryId = categoryRaw && categoryRaw !== 'all' ? categoryRaw : undefined;

      // 周期类型：优先枚举 date_type（1 日 / 2 周 / 3 月），否则按文本推断
      const byEnum: Record<string, RankingQuery['rankingType']> = { '1': 'daily', '2': 'weekly', '3': 'monthly' };
      const rankingType: RankingQuery['rankingType'] | undefined =
        (dateTypeRaw && byEnum[dateTypeRaw]) ||
        (/week/i.test(periodRaw ?? '')
          ? 'weekly'
          : /month/i.test(periodRaw ?? '')
            ? 'monthly'
            : periodRaw
              ? 'daily'
              : undefined);

      // 榜单变体：由页面路径决定（兼容 /zh/ 等语言前缀）
      const path = location.pathname;
      const rankingVariant = /newProducts/i.test(path)
        ? 'news-burst'
        : /hotlist/i.test(path)
          ? 'hot-sell'
          : /saleslist/i.test(path)
            ? 'top-sold'
            : /search/i.test(path)
              ? 'products'
              : undefined;

      // 周期值 → 表单使用的 yyyyMMdd（日榜）
      let periodStart: string | undefined;
      const pv = pick('date_value', 'dateValue');
      if (pv && /^\d{4}-\d{2}-\d{2}/.test(pv)) periodStart = pv.slice(0, 10).replace(/-/g, '');

      void dlog('fastmoss', '读取页面筛选', {
        url: location.href.slice(0, 120),
        region,
        dateTypeRaw,
        periodRaw,
        categoryId,
        rankingVariant,
      });
      return {
        ...(region ? { region } : {}),
        ...(rankingType ? { rankingType } : {}),
        ...(rankingVariant ? { rankingVariant } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(periodStart ? { periodStart } : {}),
      };
    }

    /**
     * 探测登录状态：页面上存在可见的「登录/注册」入口即视为未登录
     */
    function checkLogin(): { logged_in: boolean; evidence: string } {
      const text = (document.body?.innerText ?? '').slice(0, 4000);
      const loginHints = Array.from(document.querySelectorAll('button, a, span')).filter((el) => {
        const t = (el.textContent ?? '').trim();
        if (t.length > 12 || t.length === 0) return false;
        if (!/^(登录|登入|立即登录|Sign in|Log in)$/i.test(t)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (loginHints.length > 0) {
        return { logged_in: false, evidence: `页面存在可见登录入口（${loginHints.length} 个），判定未登录` };
      }
      if (/登录后查看|请先登录|登录即可/i.test(text)) {
        return { logged_in: false, evidence: '正文出现「登录后查看」类提示' };
      }
      return { logged_in: true, evidence: '未发现可见登录入口，判定已登录（启发式）' };
    }
  },
});
