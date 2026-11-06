/**
 * TikTok Shop 页面 content script（ISOLATED world）
 * - 商品详情就绪检测（核对 URL 商品 ID + 页面证据）
 * - 验证码/访问限制检测（challenge iframe、challenge 路由、限制文案组合信号）
 * - 妙手"采集此商品"按钮探测与点击提交、提交反馈观察
 * - MutationObserver 监测 SPA 路由变化 + 验证消失后的自动恢复信号
 */
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { wrapHandler } from '@/shared/messaging';
import { createMiaoshouAdapter } from '@/modules/miaoshou/adapter';
import { detectChallenge, isRecovered, type ChallengeSignals } from '@/modules/challenge/detector';
import { dlog } from '@/modules/debug/log';

export default defineContentScript({
  matches: ['https://www.tiktok.com/shop/*', 'https://shop.tiktok.com/*'],
  runAt: 'document_idle',
  main() {
    const miaoshou = createMiaoshouAdapter();
    /** 上次上报的验证状态（避免重复上报） */
    let lastChallengeState: 'CLEAR' | 'CHALLENGE' | 'ACCESS_RESTRICTED' = 'CLEAR';
    /** 是否处于等待验证恢复中 */
    let waitingRecovery = false;
    /** 已上报“地区不可用”的页面 URL（避免重复上报） */
    let lastRegionReportedUrl = '';

    void browser.runtime
      .sendMessage({ type: 'cs.contentReady', payload: { site: 'tiktok', url: location.href } })
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
        case 'tiktok.probe':
          return wrapHandler<'tiktok.probe'>(async (payload) => {
            return probe(payload.expectedProductId);
          })(msg.payload as { expectedProductId: string }, null);
        case 'tiktok.detectMiaoshou':
          await dlog('tiktok', '收到检测妙手请求', { url: location.href.slice(0, 100) });
          return wrapHandler<'tiktok.detectMiaoshou'>(async () => miaoshou.detectAvailability())(undefined, null);
        case 'tiktok.submitCollect':
          await dlog('tiktok', '收到提交采集请求');
          return wrapHandler<'tiktok.submitCollect'>(async () => miaoshou.submitCollectAction())(undefined, null);
        case 'tiktok.verifyCollect':
          return wrapHandler<'tiktok.verifyCollect'>(async (payload) => {
            return miaoshou.verifyCollection(payload.productId);
          })(msg.payload as { productId: string }, null);
        default:
          return { ok: false, error: { code: 'UNKNOWN_MESSAGE', message: String(msg.type) } };
      }
    }

    /**
     * 从 URL 提取商品 ID（兼容 shop.tiktok.com/{region}/pdp/{slug}/{id} 落地页与查询参数）
     * @param url 页面 URL
     */
    function productIdFromUrl(url: string): string | null {
      // 真实落地页：/us/pdp/{slug}/{id}
      const m = url.match(/\/pdp\/(?:[^/?#]*\/)*(\d{6,})(?:[/?#]|$)/);
      if (m) return m[1]!;
      // FastMoss 等榜单来源提供的 TikTok Shop 详情链接：/view/product/{id}?region=XX
      const viewProduct = url.match(/\/view\/product\/(\d{6,})(?:[/?#]|$)/);
      if (viewProduct) return viewProduct[1]!;
      const legacy = url.match(/\/shop\/pdp\/(\d+)/);
      if (legacy) return legacy[1]!;
      const q = url.match(/[?&]productId=(\d+)/);
      return q ? q[1]! : null;
    }

    /**
     * 查找页面商品证据（标题/价格/购买区 DOM）
     */
    function findProductEvidence(): boolean {
      // 组合探针：商品标题容器 + 价格元素 + 购买按钮区（任一命中即视为有商品内容）
      const probes = [
        'h1',
        '[class*="product-title"]',
        '[class*="price"]',
        '[data-testid*="pdp"]',
        'button[class*="buy"], [class*="add-to-cart"]',
      ];
      return probes.some((sel) => {
        const el = document.querySelector(sel);
        return el != null && (el.textContent ?? '').trim().length > 0;
      });
    }

    /**
     * 识别“商品在当前国家/地区不可用”的页面提示
     * @param text 页面正文采样
     * @returns 命中的提示文本片段；未命中返回 null
     */
    function detectRegionUnavailable(text: string): string | null {
      const compact = text.replace(/\s+/g, ' ');
      const patterns = [
        /此国家或地区未提供/,
        /该地区(?:暂|未)提供/,
        /当前地区(?:暂|未)提供/,
        /not available in (?:your|this) (?:country|region)/i,
        /currently unavailable in (?:your|this) (?:country|region)/i,
        /(?:is|isn't) not available in your (?:country|region)/i,
      ];
      for (const p of patterns) {
        const m = compact.match(p);
        if (m) return compact.slice(Math.max(0, m.index! - 30), m.index! + 80).trim();
      }
      return null;
    }

    /** 元素是否真实可见（TikTok 常内置隐藏的 captcha 容器，必须排除以免误判为验证） */
    function isVisible(el: Element): boolean {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    /**
     * 采集页面验证/访问限制信号
     */
    function collectSignals(): ChallengeSignals {
      const hasChallengeIframe = Array.from(document.querySelectorAll('iframe')).some(
        (f) => /captcha|challenge|arkose|sec-sdk/i.test(f.src || '') && isVisible(f),
      );
      const hasCaptchaDom = Array.from(
        document.querySelectorAll(
          '[class*="captcha"], [id*="captcha"], [class*="secsdk"], [id*="secsdk"]',
        ),
      ).some(isVisible);
      return {
        url: location.href,
        title: document.title,
        hasChallengeIframe,
        hasCaptchaDom,
        bodyTextSample: (document.body?.innerText ?? '').slice(0, 2000),
        productEvidenceFound: findProductEvidence(),
      };
    }

    /**
     * 综合探测：商品就绪 / 验证 / 访问限制 / 商品不匹配
     * @param expectedProductId 期望商品 ID
     */
    async function probe(expectedProductId: string): Promise<{
      state: 'READY' | 'CHALLENGE' | 'ACCESS_RESTRICTED' | 'MISMATCH' | 'LOADING' | 'REGION_UNAVAILABLE';
      productId?: string;
      reason?: string;
      evidence?: string;
    }> {
      const signals = collectSignals();
      const verdict = detectChallenge(signals);
      if (verdict.state === 'CHALLENGE' || verdict.state === 'ACCESS_RESTRICTED') {
        await dlog('tiktok', 'probe: 命中验证/限制', { matched: verdict.matchedRules.join(',') });
        return {
          state: verdict.state,
          evidence: `命中规则: ${verdict.matchedRules.join(', ')}`,
        };
      }
      // 地区不可用优先于商品证据判断：页面会正常渲染但没有购买区
      const regionHit = detectRegionUnavailable(signals.bodyTextSample ?? '');
      if (regionHit) {
        await dlog('tiktok', 'probe: 地区不可用', { hit: regionHit });
        return { state: 'REGION_UNAVAILABLE', evidence: regionHit };
      }
      const urlProductId = productIdFromUrl(location.href);
      if (!urlProductId) {
        return { state: 'LOADING', reason: 'URL 中未解析到商品 ID（可能仍在跳转）' };
      }
      if (urlProductId !== expectedProductId) {
        return {
          state: 'MISMATCH',
          productId: urlProductId,
          reason: `URL 商品 ID ${urlProductId} 与任务期望 ${expectedProductId} 不一致`,
        };
      }
      // 新版 TikTok Shop PDP 的标题/价格 DOM 经常变化，不能把启用妙手采集的前置条件
      // 绑死在这些弱选择器上。URL 已精确匹配商品且没有验证时即可推进；后续妙手适配器
      // 会独立等待最多 30 秒，确认“采集此商品”按钮真正注入后才点击。
      const evidence = signals.productEvidenceFound
        ? 'URL 商品 ID 匹配且页面证据存在'
        : 'URL 商品 ID 匹配（商品 DOM 探针未命中，继续等待妙手按钮注入）';
      await dlog('tiktok', 'probe: 页面就绪', { productId: urlProductId, productEvidenceFound: signals.productEvidenceFound });
      return { state: 'READY', productId: urlProductId, evidence };
    }

    /**
     * 检测验证状态变化并向 background 上报事件
     */
    function checkAndReport(): void {
      const signals = collectSignals();
      const verdict = detectChallenge(signals);
      if (verdict.state !== 'CLEAR' && lastChallengeState === 'CLEAR') {
        lastChallengeState = verdict.state;
        waitingRecovery = true;
        void browser.runtime
          .sendMessage({
            type: 'tiktok.challenge',
            payload: {
              kind: verdict.state,
              evidence: `命中规则: ${verdict.matchedRules.join(', ')}`,
              url: location.href,
            },
          })
          .catch(() => undefined);
        return;
      }
      // 验证消失后的自动恢复信号：验证消失 + 商品内容恢复 + 妙手按钮可用
      if (verdict.state === 'CLEAR' && waitingRecovery) {
        void (async () => {
          const availability = await miaoshou.detectAvailability();
          const recovered = isRecovered({ ...signals, miaoshouAvailable: availability.available });
          if (recovered) {
            waitingRecovery = false;
            lastChallengeState = 'CLEAR';
            void browser.runtime
              .sendMessage({ type: 'tiktok.challengeResolved', payload: { url: location.href } })
              .catch(() => undefined);
          }
        })();
      }
      // 地区不可用：主动上报，让 background 立即暂停批次，避免继续消耗任务
      const productId = productIdFromUrl(location.href);
      const regionHit = detectRegionUnavailable(signals.bodyTextSample ?? '');
      if (productId && regionHit && lastRegionReportedUrl !== location.href) {
        lastRegionReportedUrl = location.href;
        void browser.runtime
          .sendMessage({
            type: 'tiktok.regionUnavailable',
            payload: { evidence: regionHit, url: location.href, productId },
          })
          .catch(() => undefined);
        return;
      }
      // URL 商品 ID 匹配已足以让后台进入妙手按钮检测；不要依赖易变的商品 DOM 结构。
      if (productId && verdict.state === 'CLEAR') {
        void dlog('tiktok', '上报商品页面就绪', {
          productId,
          productEvidenceFound: signals.productEvidenceFound,
          url: location.href.slice(0, 160),
        });
        void browser.runtime
          .sendMessage({ type: 'tiktok.pageReady', payload: { productId, url: location.href } })
          .catch(() => undefined);
      }
    }

    // MutationObserver 监测 SPA 路由变化与 DOM 变化（节流 1s）
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        checkAndReport();
      }, 1_000);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // 初始延迟检测一次（等待 SPA 首屏渲染）
    setTimeout(checkAndReport, 2_000);
    // 人工完成验证后，TikTok 有时只更新 iframe 内部状态而不会触发当前文档的 DOM mutation。
    // 等待恢复期间定时复查，确保验证页恢复商品内容后能主动通知 background 继续执行。
    setInterval(() => {
      if (waitingRecovery) checkAndReport();
    }, 3_000);
  },
});
