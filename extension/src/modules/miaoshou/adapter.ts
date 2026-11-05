/**
 * 妙手 ERP "采集此商品" 按钮 DOM 适配器（规范 §5.2）
 *
 * ⚠️ PoC 待验证：以下选择器均为候选探针，未在真实 Chrome + 妙手官方插件环境验证。
 * 验证前不得宣称无人值守批量导入已实现。选择器采用配置版本 + 多探针候选数组：
 * data-* 属性优先，文案匹配兜底；附可见性/可点击性判断；不做坐标点击。
 *
 * 本模块运行于 TikTok 商品页 content script（ISOLATED world）内。
 */
import type { IMiaoshouAdapter } from '@/shared/types/domain';
import { dlog } from '@/modules/debug/log';

/** 选择器配置（版本化，PoC 后更新） */
export interface MiaoshouSelectorConfig {
  version: string;
  /** data-* / 属性优先的候选选择器 */
  attributeSelectors: string[];
  /** 文案匹配候选（按钮/a/div 内文本） */
  textCandidates: string[];
  /** 提交后反馈探针（toast/弹框文案） */
  feedback: {
    successText: string[];
    failureText: string[];
    loadingText: string[];
  };
}

/** 默认选择器配置（⚠️ PoC 待验证，禁止当作已验证结论） */
export const DEFAULT_MIAOSHOU_SELECTORS: MiaoshouSelectorConfig = {
  version: 'miaoshou-selectors/0.1.0-poc-unverified',
  attributeSelectors: [
    '[data-miaoshou-collect]',
    '[data-ms-collect]',
    '[class*="miaoshou"][class*="collect"]',
    '[class*="collect"][class*="product"]',
  ],
  textCandidates: ['采集此商品', '采集商品', '一键采集', '采集到妙手'],
  feedback: {
    successText: ['采集成功', '已加入采集箱', '采集完成'],
    failureText: ['采集失败', '已采集过', '重复采集'],
    loadingText: ['采集中', '正在采集'],
  },
};

/** 反馈观察结果 */
export interface SubmitFeedback {
  kind: 'SUCCESS_TOAST' | 'FAILURE_TOAST' | 'LOADING' | 'NONE';
  text?: string;
}

/** 不可见字符（零宽/方向控制/软连字符等）：按钮文案常夹带，直接匹配会失败 */
const INVISIBLE_RE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/**
 * 归一化文本：移除不可见字符并压缩空白，用于文案匹配
 * （真实页面按钮文本常见形如「采\u200E集此商品」）
 * @param raw 原始文本
 */
export function normalizeText(raw: string): string {
  return raw.replace(INVISIBLE_RE, '').replace(/\s+/g, '').trim();
}

/**
 * 深度查询：document + 开放 shadow root（最多 4 层）
 * 妙手插件 UI 常挂在 shadow root 中，普通 querySelector 找不到
 * @param selector CSS 选择器
 * @param root 查询根节点
 * @param depth 当前递归深度
 */
function queryDeep(selector: string, root: Document | ShadowRoot = document, depth = 0): Element[] {
  const out = Array.from(root.querySelectorAll(selector));
  if (depth >= 4) return out;
  for (const host of root.querySelectorAll('*')) {
    const sr = (host as Element).shadowRoot;
    if (sr) out.push(...queryDeep(selector, sr, depth + 1));
  }
  return out;
}

/**
 * 模拟真实鼠标点击：滚动到可见区域后依次派发 pointer/mouse 事件
 * 部分插件只响应完整指针序列，裸 HTMLElement.click() 会被静默忽略
 * @param el 目标元素
 */
function dispatchRealClick(el: Element): void {
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
  const pointer = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  el.dispatchEvent(new PointerEvent('pointerover', pointer));
  el.dispatchEvent(new MouseEvent('mouseover', base));
  el.dispatchEvent(new PointerEvent('pointerdown', pointer));
  el.dispatchEvent(new MouseEvent('mousedown', base));
  el.dispatchEvent(new PointerEvent('pointerup', pointer));
  el.dispatchEvent(new MouseEvent('mouseup', base));
  el.dispatchEvent(new MouseEvent('click', base));
  // 兜底：有些实现只挂在原生 click 上
  if (el instanceof HTMLElement) el.click();
}

/**
 * 统计页面中带 shadow root 的元素数量
 */
function countShadowHosts(): number {
  return Array.from(document.querySelectorAll('*')).filter((el) => el.shadowRoot).length;
}

/**
 * 收集页面结构诊断信息（用于定位按钮到底藏在哪里）
 * - 开放 shadow root 宿主数量
 * - iframe 数量与来源域名（跨域 iframe 内容自研脚本无法访问）
 * - 关键词命中数量（妙手/ERP/采集），用于判断插件是否已注入
 */
function collectStructureHints(): string {
  const shadowHosts = countShadowHosts();
  const iframes = Array.from(document.querySelectorAll('iframe')).map((f) => {
    const src = f.getAttribute('src');
    if (!src) return 'inline';
    try {
      return new URL(src, location.href).host;
    } catch {
      return '?';
    }
  });
  const hosts = iframes.slice(0, 5).join(',');
  const hits = ['妙手', 'ERP', '采集箱'].map((kw) => {
    const n = Array.from(document.querySelectorAll('body *')).filter((el) =>
      (el.textContent ?? '').includes(kw),
    ).length;
    return `${kw}:${n}`;
  });
  return `shadow 宿主 ${shadowHosts} 个；iframe ${iframes.length} 个${hosts ? `（${hosts}）` : ''}；关键词命中 ${hits.join(' ')}`;
}

/**
 * 判断元素是否可见且可点击
 * @param el 元素
 */
export function isVisibleAndClickable(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }
  return !(el as HTMLButtonElement).disabled;
}

/**
 * 创建妙手适配器
 * @param config 选择器配置（默认 DEFAULT_MIAOSHOU_SELECTORS，PoC 待验证）
 */
export function createMiaoshouAdapter(
  config: MiaoshouSelectorConfig = DEFAULT_MIAOSHOU_SELECTORS,
): IMiaoshouAdapter {
  /**
   * 在 document（含开放 shadow root）中按候选选择器查找按钮
   */
  function findButton(): Element | null {
    // 1) data-* / 属性优先
    for (const sel of config.attributeSelectors) {
      const el = queryDeep(sel)[0];
      if (el && isVisibleAndClickable(el)) return el;
    }
    // 2) 文案匹配：优先真正的交互元素（button/a/role=button），减少命中普通文本节点
    const wanted = config.textCandidates.map(normalizeText);
    const textMatch = (el: Element): boolean => {
      const text = normalizeText(el.textContent ?? '');
      if (!text) return false;
      // 只接受「自身文案即按钮文案」的节点，避免命中整页容器
      return wanted.some(
        (t) => text === t || (text.includes(t) && text.length <= t.length + 6),
      );
    };
    for (const el of queryDeep('button, a, [role="button"]')) {
      if (textMatch(el) && isVisibleAndClickable(el)) return el;
    }
    // 3) 兜底：普通节点上的文字按钮
    for (const el of queryDeep('div, span')) {
      if (textMatch(el) && isVisibleAndClickable(el)) return el;
    }
    return null;
  }

  /**
   * 观察提交后的 toast/DOM 反馈（有限时间内）
   * @param timeoutMs 超时
   */
  function observeFeedback(timeoutMs: number): Promise<SubmitFeedback> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        observer.disconnect();
        resolve({ kind: 'NONE' });
      }, timeoutMs);
      const check = (raw: string): SubmitFeedback | null => {
        const text = normalizeText(raw).slice(0, 120);
        if (config.feedback.successText.some((t) => text.includes(normalizeText(t)))) {
          return { kind: 'SUCCESS_TOAST', text };
        }
        if (config.feedback.failureText.some((t) => text.includes(normalizeText(t)))) {
          return { kind: 'FAILURE_TOAST', text };
        }
        if (config.feedback.loadingText.some((t) => text.includes(normalizeText(t)))) {
          return { kind: 'LOADING', text };
        }
        return null;
      };
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const text = (node as Element).textContent ?? '';
              const fb = check(text);
              if (fb && fb.kind !== 'LOADING') {
                clearTimeout(timer);
                observer.disconnect();
                resolve(fb);
                return;
              }
            }
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  return {
    /**
     * 检测妙手采集能力是否可用（含证据说明）
     * 妙手插件的内容脚本通常在页面加载完成后才注入按钮，因此这里轮询等待而非单次判定
     */
    async detectAvailability() {
      const startedAt = Date.now();
      await dlog('miaoshou', '开始检测采集按钮', { readyState: document.readyState, url: location.href.slice(0, 120) });
      let btn = findButton();
      // 轮询等待插件注入（最长 30 秒，每 800ms 检查一次）
      while (!btn && Date.now() - startedAt < 30_000) {
        await new Promise((r) => setTimeout(r, 800));
        btn = findButton();
      }
      if (btn) {
        const waited = Math.round((Date.now() - startedAt) / 1000);
        await dlog('miaoshou', '命中采集按钮', { waitedSec: waited, tag: btn.tagName, cls: (btn.getAttribute('class') ?? '').slice(0, 60), text: normalizeText(btn.textContent ?? '').slice(0, 20) });
        return {
          available: true,
          evidence: `候选按钮命中: ${btn.tagName}.${(btn.getAttribute('class') ?? '').slice(0, 80)}（等待 ${waited}s，选择器版本 ${config.version}，PoC 待验证）`,
        };
      }
      // 未命中时给出可诊断线索：页面正文是否真的出现“采集”字样
      const pageText = normalizeText(document.body?.innerText ?? '');
      const hint = pageText.includes('采集')
        ? '页面正文含“采集”字样，但未找到可见可点击的按钮节点'
        : '页面正文不含“采集”字样（妙手插件可能未加载或未适配该页面）';
      await dlog('miaoshou', '未命中采集按钮', { hint, structure: collectStructureHints() });
      return {
        available: false,
        evidence: `等待 30s 未命中任何候选探针：${hint}；${collectStructureHints()} (选择器版本 ${config.version})`,
        reason: 'MIAOSHOU_BUTTON_NOT_FOUND',
      };
    },

    /**
     * 探明采集动作是否可程序触发（PoC 项：合成 click 是否被妙手接受未验证）
     */
    async findCollectAction() {
      const btn = findButton();
      if (!btn) return { supported: false, reason: 'MIAOSHOU_BUTTON_NOT_FOUND' };
      return { supported: true };
    },

    /**
     * 触发采集动作并观察反馈
     * 使用完整指针事件序列（pointerdown/mousedown/mouseup/click）而不是裸 .click()，
     * 因为多数插件用 pointer/mouse 事件做守卫，裸 click 可能被静默忽略
     */
    async submitCollectAction() {
      const startedAt = Date.now();
      let btn = findButton();
      // 提交前再等一次（适配页面刚渲染完成、按钮稍后出现的场景）
      while (!btn && Date.now() - startedAt < 10_000) {
        await new Promise((r) => setTimeout(r, 400));
        btn = findButton();
      }
      if (!btn) {
        await dlog('miaoshou', '提交前未找到按钮');
        return { submitted: false, errorCode: 'MIAOSHOU_BUTTON_NOT_FOUND' };
      }
      // 文字节点常是按钮内部的 span，向上找真正的可点击容器再点
      const clickTarget = btn.closest('button, a, [role="button"], [class*="btn"], [class*="button"]') ?? btn;
      const desc = `${clickTarget.tagName.toLowerCase()}.${(clickTarget.getAttribute('class') ?? '').slice(0, 60)} text="${normalizeText(clickTarget.textContent ?? '').slice(0, 20)}"`;
      const before = { nodes: document.querySelectorAll('body *').length, shadows: countShadowHosts() };
      await dlog('miaoshou', '派发点击', { target: desc, nodes: before.nodes, shadows: before.shadows });
      const feedbackPromise = observeFeedback(12_000);
      dispatchRealClick(clickTarget);
      const fb = await feedbackPromise;
      const after = { nodes: document.querySelectorAll('body *').length, shadows: countShadowHosts() };
      const delta = `节点 +${after.nodes - before.nodes}，shadow 宿主 +${after.shadows - before.shadows}`;
      await dlog('miaoshou', '点击后反馈', { kind: fb.kind, text: (fb.text ?? '').slice(0, 60), delta });
      if (fb.kind === 'SUCCESS_TOAST') {
        return { submitted: true, evidence: `已点击 ${desc}；提交后出现成功反馈: ${fb.text?.slice(0, 120)}` };
      }
      if (fb.kind === 'FAILURE_TOAST') {
        return { submitted: false, evidence: `已点击 ${desc}；失败反馈: ${fb.text?.slice(0, 120)}`, errorCode: 'MIAOSHOU_FEEDBACK_FAILURE' };
      }
      // 无明确反馈：点击动作已发出但无提交证据；同时记录 DOM 变化量用于判断点击是否真的生效
      return {
        submitted: false,
        evidence: `已点击 ${desc}；未观察到明确提交反馈；点击后 ${delta}（PoC 待验证反馈探针）`,
        errorCode: 'MIAOSHOU_NO_FEEDBACK',
      };
    },

    /**
     * 核对商品是否已进入 ERP 采集箱。
     * 当前无经过授权的 ERP 侧核对途径（规范 §5.2 硬性规定）：
     * 绝不可把点击成功当 ERP 成功，统一返回 UNKNOWN 并附说明。
     * @param productId 商品 ID
     */
    async verifyCollection(productId: string) {
      return {
        state: 'UNKNOWN' as const,
        evidence: `无授权 ERP 核对途径，商品 ${productId} 的采集箱状态无法确认（PoC 待验证）`,
      };
    },
  };
}
