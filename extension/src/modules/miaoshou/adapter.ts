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
  /** 点击后可能弹出的采集面板容器选择器 */
  panelSelectors: string[];
}

/** 默认选择器配置（⚠️ PoC 待验证，禁止当作已验证结论） */
export const DEFAULT_MIAOSHOU_SELECTORS: MiaoshouSelectorConfig = {
  version: 'miaoshou-selectors/0.2.0-poc-unverified',
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
  panelSelectors: [
    '[class*="collect-panel"][class*="body"]',
    '[class*="collect-drawer"]',
    '[class*="collect-modal"]',
    '[class*="collect-dialog"]',
  ],
};

/** 已弹出的采集面板（容器 + 可用于查询的根） */
export interface OpenedPanel {
  /** 面板宿主元素 */
  host: Element;
  /** 查询根：宿主自身的 shadowRoot（若没有则用宿主的父级文档） */
  root: Document | ShadowRoot;
  /** 便于日志识别的描述 */
  desc: string;
  /** 面板内可见文本摘要（正常化后截断） */
  text?: string;
}

/** 反馈观察结果 */
export interface SubmitFeedback {
  kind: 'SUCCESS_TOAST' | 'FAILURE_TOAST' | 'LOADING' | 'PANEL_OPENED' | 'NONE';
  text?: string;
  /** PANEL_OPENED 时携带面板信息，便于二次确认 */
  panel?: OpenedPanel;
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

/** 妙手插件渲染的 class 前缀（实测为 earth-wxt-*） */
const MIAOSHOU_CLASS_PREFIX = 'earth-wxt-';

/**
 * 统计页面上妙手插件渲染的节点数量（含开放 shadow root 内）
 * 用于判断点击后插件是否真的产生响应，避免被页面其他变化（如 cookie 横幅）误导
 */
function countMiaoshouNodes(): number {
  return new Set(queryDeep(`[class*="${MIAOSHOU_CLASS_PREFIX}"]`)).size;
}

/** 读取一节文本：元素自身文本 + 其开放 shadow root 内的文本 */
function nodeText(node: Node): string {
  if (!(node instanceof Element)) return '';
  return `${node.textContent ?? ''} ${node.shadowRoot?.textContent ?? ''}`;
}

/** 快照当前所有开放 shadow 宿主（用于判断点击后新增了哪些） */
function snapshotShadowHosts(): Set<Element> {
  return new Set(Array.from(document.querySelectorAll('*')).filter((el) => el.shadowRoot));
}

/**
 * 查找妙手点击后弹出的采集面板
 * 实测点击“采集此商品”后会新增约 3000 个节点并出现 1 个 shadow root，
 * 面板通常挂在 class 含 collect/panel/dialog 的容器上
 * @param selectors 面板容器候选选择器
 * @param knownHosts 点击前已有的 shadow 宿主集合（用于识别“新增”）
 * @returns 命中的面板，未出现返回 null
 */
function findOpenedPanel(selectors: string[], knownHosts: Set<Element>): OpenedPanel | null {
  const wrap = (host: Element): OpenedPanel => {
    const root = host.shadowRoot ?? (host.getRootNode() as Document | ShadowRoot);
    const cls = (host.getAttribute('class') ?? '').slice(0, 60);
    // 只取宿主自身 shadow root 的文本；否则会拿到整篇文档
    const raw = host.shadowRoot?.textContent ?? '';
    return {
      host,
      root,
      desc: `${host.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`,
      text: normalizeText(raw).slice(0, 160),
    };
  };
  for (const sel of selectors) {
    const el = queryDeep(sel).find((e) => isVisibleAndClickable(e));
    if (el) return wrap(el);
  }
  // 兜底：点击后“新增”的 shadow 宿主中，只认妙手相关的（排除 tiktok-cookie-banner 等无关组件）；
  // 多个候选时优先取文本最长的那个
  const added = Array.from(snapshotShadowHosts()).filter((el) => !knownHosts.has(el));
  const candidates = added
    .map((el) => {
      const text = el.shadowRoot?.textContent ?? '';
      const sign = `${el.tagName.toLowerCase()} ${el.getAttribute('class') ?? ''}`;
      return { el, text, related: text.includes('采集') || /earth|miaoshou|collect/i.test(sign) };
    })
    .filter((c) => c.related)
    .sort((a, b) => b.text.length - a.text.length);
  return candidates.length ? wrap(candidates[0]!.el) : null;
}

/**
 * 解析真正的点击目标
 * 实测文案命中的是 `div.earth-wxt-collect-panel-button-group`，它只是按钮组容器；
 * 直接点容器不会触发明细绑定的 click 逻辑，必须落到内部真正的按钮上
 * @param el 文案命中的元素
 */
function resolveClickTarget(el: Element): Element {
  // 1) 向下：容器内部语义化按钮或妙手自定义按钮元素。
  // 妙手当前版本使用 <earth-wxt-button class="...button...">，而不是原生 button。
  // 注意这里只查后代节点，不会把外层 *-button-group 容器误当成点击目标。
  const inner = Array.from(el.querySelectorAll('button, a, [role="button"], [class*="button"]')).filter(
    (e) => isVisibleAndClickable(e) && normalizeText(e.textContent ?? '').includes('采集'),
  );
  if (inner.length) return inner[inner.length - 1]!;
  // 2) 向上：仅认语义化按钮，禁用 [class*="button"]，否则会命中 *-button-group 容器
  const up = el.closest('button, a, [role="button"]');
  if (up) return up;
  // 3) 兜底：取文本含“采集”的最深后代，最接近真实事件目标
  let deepest: Element = el;
  for (const child of Array.from(el.querySelectorAll('*'))) {
    if (isVisibleAndClickable(child) && normalizeText(child.textContent ?? '').includes('采集')) {
      deepest = child;
    }
  }
  return deepest;
}

/**
 * 收集面板内可见的可交互元素文案，用于把“面板到底长什么样”写进调试日志
 * @param panel 已弹出的面板
 * @returns 形如 `BUTTON.cls|确定` 的清单（最多 25 条）
 */
function collectPanelButtons(panel: OpenedPanel): string[] {
  const nodes = queryDeep(
    'button, a, [role="button"], input[type="button"], [class*="btn"], [class*="button"]',
    panel.root,
  );
  const out: string[] = [];
  for (const el of nodes) {
    if (out.length >= 25) break;
    if (!isVisibleAndClickable(el)) continue;
    const text = normalizeText(el.textContent ?? '').slice(0, 16);
    const cls = (el.getAttribute('class') ?? '').slice(0, 40);
    const key = `${el.tagName.toLowerCase()}.${cls}|${text}`;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** 面板内“确认类”按钮文案白名单（用于完成需要二次确认的采集流程） */
const CONFIRM_TEXTS = [
  '确定',
  '确认',
  '确认采集',
  '加入采集箱',
  '开始采集',
  '马上采集',
  '立即采集',
  '保存并采集',
];

/**
 * 在面板内查找二次确认按钮
 * 严格限制在面板子树内 + 文案白名单，避免误点页面其他按钮
 * @param panel 已弹出的面板
 */
function findConfirmButton(panel: OpenedPanel): Element | null {
  const nodes = queryDeep(
    'button, a, [role="button"], input[type="button"], [class*="btn"], [class*="button"]',
    panel.root,
  );
  for (const el of nodes) {
    if (!isVisibleAndClickable(el)) continue;
    const text = normalizeText(el.textContent ?? '');
    if (!text || text.length > 12) continue;
    // 排除采集入口按钮自身，避免重复点击
    if (text.includes('采集此商品')) continue;
    if (CONFIRM_TEXTS.some((t) => text === t || text.startsWith(t))) return el;
  }
  return null;
}

/**
 * 模拟真实鼠标点击：滚动到可见区域后依次派发 pointer/mouse 事件
 * 部分插件只响应完整指针序列，裸 HTMLElement.click() 会被静默忽略
 * 注意必须带上正确的 button/buttons/detail：
 * 真实 mousedown 的 buttons 为 1，默认值 0 会被插件的守卫逻辑判为非法点击
 * @param el 目标元素
 */
function dispatchRealClick(el: Element): void {
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    view: window,
    button: 0,
  };
  const pointerDown = {
    ...base,
    buttons: 1,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    pressure: 0.5,
  };
  const mouseDown = { ...base, buttons: 1, detail: 1 };
  const pointerUp = { ...base, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, pressure: 0 };
  const mouseUp = { ...base, buttons: 0, detail: 1 };
  el.dispatchEvent(new PointerEvent('pointerover', pointerDown));
  el.dispatchEvent(new PointerEvent('pointerenter', pointerDown));
  el.dispatchEvent(new MouseEvent('mouseover', mouseDown));
  el.dispatchEvent(new MouseEvent('mouseenter', mouseDown));
  el.dispatchEvent(new PointerEvent('pointermove', pointerDown));
  el.dispatchEvent(new MouseEvent('mousemove', mouseDown));
  el.dispatchEvent(new PointerEvent('pointerdown', pointerDown));
  el.dispatchEvent(new MouseEvent('mousedown', mouseDown));
  el.dispatchEvent(new PointerEvent('pointerup', pointerUp));
  el.dispatchEvent(new MouseEvent('mouseup', mouseUp));
  el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0, detail: 1 }));
  // 这里已经派发了一次 click，不能再调用 HTMLElement.click()。
  // 妙手会分别响应两次 click，额外调用会把同一商品重复加入采集箱。
}

/**
 * 生成点击候选：文案命中的节点常是内层 span 或按钮组容器，
 * 真实事件处理可能挂在任一祖先上，因此按"由内到外"顺序给出候选
 * @param el 文案命中的元素
 */
function buildClickCandidates(el: Element): Element[] {
  const out: Element[] = [el];
  let cur: Element | null = el.parentElement;
  for (let i = 0; i < 3 && cur; i++, cur = cur.parentElement) {
    const cls = cur.getAttribute('class') ?? '';
    // 只把按钮组/按钮类容器作为候选，避免点到整块商品区域
    if (/button|btn/i.test(cls) || cur.tagName === 'BUTTON' || cur.getAttribute('role') === 'button') {
      out.push(cur);
    }
  }
  return out;
}

/** 生成元素的结构摘要（标签 + 关键属性 + 截断 HTML），用于日志定位 */
function describeElement(el: Element): string {
  const cls = (el.getAttribute('class') ?? '').slice(0, 80);
  const html = (el.outerHTML ?? '').replace(/\s+/g, ' ').slice(0, 160);
  return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''} | ${html}`;
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
      if (el && isVisibleAndClickable(el)) return resolveClickTarget(el);
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
      if (textMatch(el) && isVisibleAndClickable(el)) return resolveClickTarget(el);
    }
    // 3) 兜底：普通节点上的文字按钮
    for (const el of queryDeep('div, span')) {
      if (textMatch(el) && isVisibleAndClickable(el)) return resolveClickTarget(el);
    }
    return null;
  }

  /**
   * 观察提交后的 toast/DOM 反馈（有限时间内）
   * @param timeoutMs 超时
   */
  function observeFeedback(timeoutMs: number): Promise<SubmitFeedback> {
    return new Promise((resolve) => {
      // 记录点击前的 shadow 宿主集合，用于判断“点击后新增面板”
      const shadowBaseline = snapshotShadowHosts();
      const timer = setTimeout(() => {
        observer.disconnect();
        clearInterval(panelTimer);
        resolve({ kind: 'NONE' });
      }, timeoutMs);
      // 妙手点击后会弹出较大的采集面板（不是 toast）；轮询检测面板是否出现
      const panelTimer = setInterval(() => {
        const panel = findOpenedPanel(config.panelSelectors, shadowBaseline);
        if (panel) {
          clearTimeout(timer);
          clearInterval(panelTimer);
          observer.disconnect();
          resolve({ kind: 'PANEL_OPENED', text: panel.desc, panel });
        }
      }, 400);
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
              // 关键：toast 常渲染在 shadow root 内，宿主 textContent 为空，
              // 必须连同 shadowRoot 文本一起取，否则会漏判成功/失败提示
              const text = nodeText(node);
              const fb = check(text);
              if (fb && fb.kind !== 'LOADING') {
                clearTimeout(timer);
                clearInterval(panelTimer);
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

  /**
   * 处理点击“采集此商品”后弹出的面板
   * 先记录面板内可交互元素（便于事后诊断），若存在确认类按钮则补一次点击
   * @param panel 已弹出的面板
   * @param desc 采集入口按钮描述
   * @param delta 点击前后 DOM 变化描述
   * @param feedbackTimeoutMs 二次确认后观察反馈的超时（来自执行参数）
   */
  async function handleOpenedPanel(
    panel: OpenedPanel,
    desc: string,
    delta: string,
    feedbackTimeoutMs: number,
  ): Promise<{ submitted: boolean; evidence?: string; errorCode?: string }> {
    const buttons = collectPanelButtons(panel);
    const panelText = normalizeText(panel.text ?? '');
    await dlog('miaoshou', '采集面板已弹出', {
      panel: panel.desc,
      text: panelText.slice(0, 90),
      buttons: buttons.join(' / ').slice(0, 150),
      html: (panel.host.outerHTML ?? '').slice(0, 120),
    });
    // 面板自身文案直接给出结论（常见于 shadow 内的结果提示条）
    if (config.feedback.failureText.some((t) => panelText.includes(normalizeText(t)))) {
      return {
        submitted: false,
        evidence: `已点击 ${desc}；面板提示失败: ${panelText.slice(0, 100)}`,
        errorCode: 'MIAOSHOU_FEEDBACK_FAILURE',
      };
    }
    if (config.feedback.successText.some((t) => panelText.includes(normalizeText(t)))) {
      return {
        submitted: true,
        evidence: `已点击 ${desc}；面板提示成功: ${panelText.slice(0, 100)}`,
      };
    }
    const confirm = findConfirmButton(panel);
    if (!confirm) {
      return {
        submitted: true,
        evidence: `已点击 ${desc}；插件采集面板已弹出（${panel.desc}，${delta}，面板内按钮：${buttons.slice(0, 6).join(' / ') || '无'}）`,
      };
    }
    const cTarget =
      confirm.closest('button, a, [role="button"], [class*="btn"], [class*="button"]') ?? confirm;
    const cText = normalizeText(cTarget.textContent ?? '').slice(0, 16);
    await dlog('miaoshou', '面板内命中二次确认按钮，执行点击', { target: cText, cls: (cTarget.getAttribute('class') ?? '').slice(0, 50) });
    const secondPromise = observeFeedback(feedbackTimeoutMs);
    dispatchRealClick(cTarget);
    const second = await secondPromise;
    await dlog('miaoshou', '二次确认后反馈', { kind: second.kind, text: (second.text ?? '').slice(0, 60) });
    if (second.kind === 'FAILURE_TOAST') {
      return {
        submitted: false,
        evidence: `已点击 ${desc} 并在面板内确认；确认后失败反馈: ${second.text?.slice(0, 100)}`,
        errorCode: 'MIAOSHOU_FEEDBACK_FAILURE',
      };
    }
    const okText =
      second.kind === 'SUCCESS_TOAST'
        ? `确认后成功反馈: ${second.text?.slice(0, 80)}`
        : `确认后未见失败提示（${second.kind}）`;
    return {
      submitted: true,
      evidence: `已点击 ${desc}；面板已弹出（${panel.desc}）；已点击面板确认按钮「${cText}」；${okText}`,
    };
  }

  return {
    /**
     * 检测妙手采集能力是否可用（含证据说明）
     * 妙手插件的内容脚本通常在页面加载完成后才注入按钮，因此这里轮询等待而非单次判定
     * @param opts.timeoutMs 最长等待时间（来自执行参数 button_detect_timeout_sec）
     */
    async detectAvailability(opts?: { timeoutMs?: number }) {
      const timeoutMs = Math.max(500, opts?.timeoutMs ?? 30_000);
      const startedAt = Date.now();
      await dlog('miaoshou', '开始检测采集按钮', {
        readyState: document.readyState,
        timeoutMs,
        url: location.href.slice(0, 120),
      });
      let btn = findButton();
      // 轮询等待插件注入（每 800ms 检查一次）
      while (!btn && Date.now() - startedAt < timeoutMs) {
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
        evidence: `等待 ${Math.round(timeoutMs / 1000)}s 未命中任何候选探针：${hint}；${collectStructureHints()} (选择器版本 ${config.version})`,
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
     * 因为多数插件用 pointer/mouse 事件做守卫，裸 click 可能被静默忽略；
     * 若首个目标无响应，会按"由内到外"依次尝试祖先候选（事件处理器常挂在父容器上）
     * @param opts.findButtonTimeoutMs 点击前等待按钮出现的最长时间（button_detect_timeout_sec）
     * @param opts.feedbackTimeoutMs 点击后观察反馈的最长时间（submit_result_wait_sec）
     */
    async submitCollectAction(opts?: { findButtonTimeoutMs?: number; feedbackTimeoutMs?: number }) {
      const findButtonTimeoutMs = Math.max(500, opts?.findButtonTimeoutMs ?? 10_000);
      const feedbackTimeoutMs = Math.max(500, opts?.feedbackTimeoutMs ?? 8_000);
      const startedAt = Date.now();
      let btn = findButton();
      // 提交前再等一次（适配页面刚渲染完成、按钮稍后出现的场景）
      while (!btn && Date.now() - startedAt < findButtonTimeoutMs) {
        await new Promise((r) => setTimeout(r, 400));
        btn = findButton();
      }
      if (!btn) {
        await dlog('miaoshou', '提交前未找到按钮');
        return { submitted: false, errorCode: 'MIAOSHOU_BUTTON_NOT_FOUND' };
      }
      // 记录命中元素及其祖先结构：这是判断"到底该点哪一层"的唯一可靠依据
      await dlog('miaoshou', '命中按钮结构', {
        hit: describeElement(btn),
        parent: btn.parentElement ? describeElement(btn.parentElement) : '无',
        grand: btn.parentElement?.parentElement ? describeElement(btn.parentElement.parentElement) : '无',
      });
      const candidates = buildClickCandidates(btn);
      const hostsBefore = snapshotShadowHosts();
      let lastDelta = '';
      let lastDesc = '';
      // 提交结果等待是“整次提交”的总预算，避免每个祖先候选都重新等一轮导致耗时翻倍
      const submitDeadline = Date.now() + feedbackTimeoutMs;
      // 逐个候选尝试：任一候选让妙手节点增长即视为插件已响应
      for (const target of candidates) {
        const desc = `${target.tagName.toLowerCase()}.${(target.getAttribute('class') ?? '').slice(0, 50)} text="${normalizeText(target.textContent ?? '').slice(0, 16)}"`;
        const before = {
          nodes: document.querySelectorAll('body *').length,
          shadows: countShadowHosts(),
          miaoshou: countMiaoshouNodes(),
        };
        await dlog('miaoshou', '派发点击', {
          target: desc,
          nodes: before.nodes,
          shadows: before.shadows,
          miaoshouNodes: before.miaoshou,
        });
        // 每次尝试至少给 1.5s 观察窗口，但不超过整体预算
        const budget = Math.max(1_500, submitDeadline - Date.now());
        const feedbackPromise = observeFeedback(Math.min(feedbackTimeoutMs, budget));
        dispatchRealClick(target);
        const fb = await feedbackPromise;
        const after = {
          nodes: document.querySelectorAll('body *').length,
          shadows: countShadowHosts(),
          miaoshou: countMiaoshouNodes(),
        };
        const delta = `节点 +${after.nodes - before.nodes}，shadow 宿主 +${after.shadows - before.shadows}，妙手节点 ${before.miaoshou}→${after.miaoshou}`;
        await dlog('miaoshou', '点击后反馈', { kind: fb.kind, text: (fb.text ?? '').slice(0, 60), delta });
        if (fb.kind === 'SUCCESS_TOAST') {
          return { submitted: true, evidence: `已点击 ${desc}；提交后出现成功反馈: ${fb.text?.slice(0, 120)}` };
        }
        if (fb.kind === 'PANEL_OPENED' && fb.panel) {
          return handleOpenedPanel(fb.panel, desc, delta, Math.max(1_500, submitDeadline - Date.now()));
        }
        if (fb.kind === 'FAILURE_TOAST') {
          return { submitted: false, evidence: `已点击 ${desc}；失败反馈: ${fb.text?.slice(0, 120)}`, errorCode: 'MIAOSHOU_FEEDBACK_FAILURE' };
        }
        // 妙手自身节点增加：点击被插件接受（面板/表单已渲染）
        // 不能用整页节点增长判断，TikTok 的 cookie 横幅等无关变化会造成误判
        if (after.miaoshou > before.miaoshou) {
          const late = findOpenedPanel(config.panelSelectors, hostsBefore);
          if (late) {
            return handleOpenedPanel(late, desc, delta, Math.max(1_500, submitDeadline - Date.now()));
          }
          return {
            submitted: true,
            evidence: `已点击 ${desc}；未出现 toast，但妙手节点增长（${delta}），判定插件已响应`,
          };
        }
        lastDelta = delta;
        lastDesc = desc;
        // 预算耗尽：不再尝试外层候选，直接按“无响应”收尾
        if (Date.now() >= submitDeadline) break;
      }
      // 所有候选都无响应：多为插件校验 isTrusted（合成事件不被接受）
      return {
        submitted: false,
        evidence: `已依次点击 ${candidates.length} 个候选（最内层 ${lastDesc}）；${lastDelta}，妙手始终无响应（疑似校验 isTrusted 或事件被拦截）`,
        errorCode: 'MIAOSHOU_CLICK_IGNORED',
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
