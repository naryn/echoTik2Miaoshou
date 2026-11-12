/**
 * TikTok 单 worker Tab 管理（规范 §5.1）
 * - ensureSingleTikTokTab：不存在则创建、存在则 tabs.update 导航
 * - 等待 onUpdated complete + content script ready + 商品 ID 核对
 */
import { browser } from 'wxt/browser';
import { storageGet, storageSet } from '@/modules/storage';

/**
 * 校验 URL 是否为 TikTok Shop 页面
 * @param url 待校验 URL
 */
export function isTikTokShopUrl(url: string | undefined): boolean {
  // 真实商品页会 301 到 shop.tiktok.com/{region}/pdp/{slug}/{id}，两个域名都需支持
  return !!url && (/^https:\/\/www\.tiktok\.com\/shop\//.test(url) || /^https:\/\/shop\.tiktok\.com\//.test(url));
}

/**
 * 从 TikTok 商品 URL 提取商品 ID
 * 支持形态：
 * - https://www.tiktok.com/shop/pdp/{id}
 * - https://shop.tiktok.com/{region}/pdp/{slug}/{id}（实测真实落地页）
 * - https://shop.tiktok.com/{region}/pdp/{id}
 * @param url 页面 URL
 */
export function extractProductIdFromUrl(url: string): string | null {
  // 路径中 /pdp/ 之后的最后一段纯数字（兼容带 slug 的落地页）
  const m = url.match(/\/pdp\/(?:[^/?#]*\/)*(\d{6,})(?:[/?#]|$)/);
  if (m) return m[1]!;
  // 兼容旧形态 /shop/pdp/{id}
  const legacy = url.match(/\/shop\/pdp\/(\d+)/);
  if (legacy) return legacy[1]!;
  const q = url.match(/[?&]productId=(\d+)/);
  return q ? q[1]! : null;
}

/**
 * 解析任务导航使用的商品详情 URL
 * 优先使用服务端给出的合法 TikTok Shop 链接；缺失时统一回退到规范模板
 * `https://www.tiktok.com/shop/pdp/{id}`（TikTok 会按商品归属站点重定向），
 * 避免历史商品 detail_url 为空（如 VN/TH 等非 US 商品）导致任务直接失败。
 * @param productId 商品 ID
 * @param fallback 服务端返回的详情 URL
 */
export function resolveDetailUrl(productId: string, fallback?: string | null): string {
  // 兼容已入库的 FastMoss 旧链接：/view/product/{id}?region=US&local=en。
  // 直接改写为当前可用的 PDP 路由，避免任务仍打开旧版查看页。
  if (fallback) {
    try {
      const url = new URL(fallback);
      const legacy = url.hostname === 'shop.tiktok.com'
        && url.pathname.match(/^\/view\/product\/(\d{6,})$/);
      if (legacy) {
        const market = (url.searchParams.get('region') ?? 'us').toLowerCase();
        const safeMarket = /^[a-z]{2}$/.test(market) ? market : 'us';
        return `https://shop.tiktok.com/${safeMarket}/pdp/${legacy[1]}?source=product_detail`;
      }
    } catch {
      // 下方统一按原有兜底处理。
    }
  }
  if (fallback && isTikTokShopUrl(fallback)) return fallback;
  return `https://www.tiktok.com/shop/pdp/${productId}`;
}

/**
 * 确保存在唯一的 TikTok 工作 Tab 并导航到目标 URL
 * Tab 会被固定（pinned），后续所有任务复用同一个 Tab 逐件采集
 * @param detailUrl 目标商品详情 URL
 * @param timeoutMs 等待加载超时
 * @returns worker tab id
 */
export async function ensureSingleTikTokTab(
  detailUrl: string,
  timeoutMs = 30_000,
): Promise<number> {
  const existingId = await storageGet('worker_tab_id');
  let tabId: number | null = null;

  if (existingId != null) {
    try {
      const tab = await browser.tabs.get(existingId);
      tabId = tab.id ?? null;
    } catch {
      tabId = null; // Tab 已被关闭
    }
  }

  if (tabId == null) {
    const tab = await browser.tabs.create({ url: detailUrl, active: true, pinned: true });
    tabId = tab.id ?? null;
    if (tabId == null) throw new Error('无法创建/定位 TikTok 工作 Tab');
    await storageSet('worker_tab_id', tabId);
    // 新建 Tab 不存在旧文档，直接等 complete 即可
    await waitTabComplete(tabId, timeoutMs);
  } else {
    await storageSet('worker_tab_id', tabId);
    // 已经在目标页且加载完成：不再重复导航，否则 Chrome 不会触发 loading 事件，
    // waitTabComplete 只能等满超时
    const current = await browser.tabs.get(tabId).catch(() => null);
    if (current?.status === 'complete' && current.url === detailUrl) return tabId;
    // 必须先挂监听再导航：tabs.update 返回后立刻查询，往往还会读到上一页残留的
    // complete 状态，导致后续 probe 在旧文档上执行（表现为“页面没就绪/商品不匹配”）
    const navigated = waitTabComplete(tabId, timeoutMs, { requireNavigation: true });
    await browser.tabs.update(tabId, { url: detailUrl, active: true, pinned: true });
    await navigated;
  }
  return tabId;
}

/**
 * 等待 Tab 加载到 complete 状态
 * @param tabId Tab ID
 * @param timeoutMs 超时
 * @param opts.requireNavigation 为 true 时忽略“导航开始前”的残留 complete 状态，
 *        必须观察到 loading→complete 才算加载完成（用于复用已有 Tab 的场景）
 */
export function waitTabComplete(
  tabId: number,
  timeoutMs = 30_000,
  opts: { requireNavigation?: boolean } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    let sawLoading = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** 移除监听并清理定时器 */
    const cleanup = () => {
      if (timer != null) clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(listener);
    };
    const listener = (
      updatedTabId: number,
      changeInfo: { status?: string },
    ) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'loading') sawLoading = true;
      if (changeInfo.status !== 'complete') return;
      // requireNavigation：导航尚未开始时读到的 complete 属于旧文档，必须忽略
      if (opts.requireNavigation && !sawLoading) return;
      cleanup();
      resolve();
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Tab ${tabId} 加载超时(${timeoutMs}ms)`));
    }, timeoutMs);
    browser.tabs.onUpdated.addListener(listener);
    if (!opts.requireNavigation) {
      // 若已 complete 则直接返回（新建 Tab 场景）
      void browser.tabs.get(tabId).then((tab) => {
        if (tab.status === 'complete') {
          cleanup();
          resolve();
        }
      });
    }
  });
}

/**
 * 清理失效的 worker_tab_id（Tab 被用户关闭时调用）
 * @param tabId 被关闭的 Tab ID
 */
export async function clearWorkerTabIfMatches(tabId: number): Promise<void> {
  const existing = await storageGet('worker_tab_id');
  if (existing === tabId) {
    await storageSet('worker_tab_id', null);
  }
}
