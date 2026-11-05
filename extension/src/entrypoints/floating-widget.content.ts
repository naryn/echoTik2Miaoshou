/**
 * 浮动快捷入口 Widget（规范 §3.8）
 * - Shadow DOM 隔离，48px 圆形按钮，仅 echotik.live / tiktok.com/shop 出现
 * - 鼠标悬停：以图标为圆心扇形展开圆角快捷菜单（采集当前榜单/控制面板/暂停/定位），
 *   移开自动收回；点击也可切换（兼容触控板/触屏）
 * - 中心显示实时采集进度（done/total），外圈按百分比显示进度环
 * - Pointer Events 拖拽（拖拽不触发页面点击）、边缘吸附
 * - 长按/右键关闭当前站点；位置按 origin 存 chrome.storage.local
 * - 状态色：待机灰/采集蓝进度环/验证橙/失败红点/完成绿点 + aria-label
 * - 通过 runtime.onMessage 订阅状态，不持有权威数据
 */
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import type { RuntimePublicState } from '@/shared/types';

const HOST_ID = 'echotik-miaoshou-widget-host';
const BTN_SIZE = 48;
const ITEM_SIZE = 42;
/** 扇形菜单半径（图标中心到菜单项中心） */
const FAN_RADIUS = 64;
/** 移出后收回的延迟，避免从图标移向菜单项时误收回 */
const CLOSE_DELAY_MS = 300;

interface WidgetPrefs {
  x?: number;
  y?: number;
  collapsed?: boolean;
  hidden?: boolean;
}

export default defineContentScript({
  matches: ['https://echotik.live/*', 'https://www.tiktok.com/shop/*', 'https://shop.tiktok.com/*'],
  runAt: 'document_idle',
  main() {
    const origin = location.origin;
    const isEchoTik = location.hostname === 'echotik.live';
    let prefs: WidgetPrefs = {};
    let state: RuntimePublicState | null = null;
    let shadow: ShadowRoot | null = null;
    let hostEl: HTMLElement | null = null;
    let dockEl: HTMLElement | null = null;
    let btnEl: HTMLButtonElement | null = null;
    let menuEl: HTMLElement | null = null;
    let ringEl: HTMLElement | null = null;
    let labelEl: HTMLElement | null = null;
    let badgeEl: HTMLElement | null = null;
    let items: HTMLButtonElement[] = [];
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    let toastTimer: ReturnType<typeof setTimeout> | null = null;
    /** 点击动作后抑制重新展开，直到指针离开 */
    let suppressOpen = false;
    /** 菜单展开期间监听全局指针位置，移出即收回 */
    let trackingPointer = false;

    void init();

    /**
     * 初始化：读取偏好 → 挂载 → 订阅状态
     */
    async function init(): Promise<void> {
      prefs = await loadPrefs();
      if (prefs.hidden) return; // 本站点已被用户关闭
      mount();
      browser.runtime.onMessage.addListener((msg: { type?: string; payload?: RuntimePublicState }) => {
        if (msg.type === 'runtime.state.push' && msg.payload) {
          state = msg.payload;
          render();
        }
      });
      state = await queryState();
      render();
      window.addEventListener('resize', () => {
        keepInViewport();
        if (menuEl?.classList.contains('open')) layoutMenu();
      });
    }

    /**
     * 向 background 查询最新状态（挂载时拉取一次）
     */
    async function queryState(): Promise<RuntimePublicState | null> {
      try {
        const resp = (await browser.runtime.sendMessage({ type: 'client.getState', payload: undefined })) as {
          ok: boolean;
          data?: RuntimePublicState;
        };
        return resp?.ok ? (resp.data ?? null) : null;
      } catch {
        return null;
      }
    }

    /**
     * 读取本 origin 的 Widget 偏好
     */
    async function loadPrefs(): Promise<WidgetPrefs> {
      const res = await browser.storage.local.get('widget_preferences_by_origin');
      const all = (res['widget_preferences_by_origin'] ?? {}) as Record<string, WidgetPrefs>;
      return all[origin] ?? {};
    }

    /**
     * 保存本 origin 的 Widget 偏好
     * @param patch 偏好增量
     */
    async function savePrefs(patch: Partial<WidgetPrefs>): Promise<void> {
      prefs = { ...prefs, ...patch };
      const res = await browser.storage.local.get('widget_preferences_by_origin');
      const all = (res['widget_preferences_by_origin'] ?? {}) as Record<string, WidgetPrefs>;
      all[origin] = prefs;
      await browser.storage.local.set({ widget_preferences_by_origin: all });
    }

    /**
     * 挂载 Shadow DOM 宿主（防重复注入）
     */
    function mount(): void {
      if (document.getElementById(HOST_ID)) return;
      const host = document.createElement('div');
      host.id = HOST_ID;
      host.style.cssText = 'all: initial; position: fixed; z-index: 2147483646;';
      shadow = host.attachShadow({ mode: 'closed' });
      shadow.innerHTML = buildHtml();
      document.documentElement.appendChild(host);
      hostEl = host;

      dockEl = shadow.querySelector('.etm-dock');
      btnEl = shadow.querySelector('.etm-btn');
      menuEl = shadow.querySelector('.etm-menu');
      ringEl = shadow.querySelector('.etm-ring');
      labelEl = shadow.querySelector('.etm-label');
      badgeEl = shadow.querySelector('.etm-badge');
      items = Array.from(shadow.querySelectorAll<HTMLButtonElement>('.etm-item'));

      bindDrag(host);
      bindHover();
      bindActions();
      applyPosition(host);
    }

    /**
     * 生成 Shadow DOM 内部 HTML（手写简洁 CSS）
     */
    function buildHtml(): string {
      return `
<style>
  :host { all: initial; }
  .etm-dock {
    position: relative; width: ${BTN_SIZE}px; height: ${BTN_SIZE}px;
    font: 600 11px/1 system-ui; user-select: none;
  }
  .etm-btn {
    width: ${BTN_SIZE}px; height: ${BTN_SIZE}px; border-radius: 50%;
    background: #6b7280; color: #fff; border: none; cursor: grab;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 2px 10px rgba(0,0,0,.3); position: relative;
    user-select: none; touch-action: none; padding: 0;
    transition: width .2s, height .2s, background .2s;
  }
  .etm-btn.collapsed { width: 16px; height: 16px; }
  .etm-btn.collapsed .etm-label, .etm-btn.collapsed .etm-ring, .etm-btn.collapsed .etm-badge { display: none; }
  .etm-label { position: relative; z-index: 1; letter-spacing: .2px; pointer-events: none; }
  .etm-ring {
    position: absolute; inset: -3px; border-radius: 50%;
    background: conic-gradient(#2563eb var(--p, 0%), transparent 0);
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 0);
            mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 0);
    display: none; pointer-events: none;
  }
  .etm-btn.running { background: #2563eb; }
  .etm-btn.running .etm-ring { display: block; }
  .etm-btn.verifying { background: #f59e0b; }
  .etm-badge {
    position: absolute; top: -2px; right: -2px; width: 12px; height: 12px;
    border-radius: 50%; display: none; border: 2px solid #fff;
  }
  .etm-badge.error { display: block; background: #ef4444; }
  .etm-badge.done { display: block; background: #22c55e; }

  /* 扇形快捷菜单：以图标为圆心展开 */
  .etm-menu { position: absolute; left: 0; top: 0; width: ${BTN_SIZE}px; height: ${BTN_SIZE}px; pointer-events: none; }
  .etm-item {
    position: absolute; left: ${(BTN_SIZE - ITEM_SIZE) / 2}px; top: ${(BTN_SIZE - ITEM_SIZE) / 2}px;
    width: ${ITEM_SIZE}px; height: ${ITEM_SIZE}px; border-radius: 50%;
    border: 1px solid rgba(255,255,255,.55); cursor: pointer; padding: 0;
    display: flex; align-items: center; justify-content: center;
    color: #fff; background: linear-gradient(135deg, var(--c1), var(--c2));
    box-shadow: inset 0 1px 0 rgba(255,255,255,.35), 0 8px 18px rgba(15,23,42,.28);
    opacity: 0; transform: translate(0, 0) scale(.3);
    pointer-events: none;
    transition: transform .22s cubic-bezier(.34,1.56,.64,1), opacity .14s ease, box-shadow .15s, filter .15s;
  }
  /* 各动作配色 */
  .etm-item[data-act="collect-here"] { --c1: #3b82f6; --c2: #1d4ed8; }
  .etm-item[data-act="open"] { --c1: #8b5cf6; --c2: #6d28d9; }
  .etm-item[data-act="pause"] { --c1: #f59e0b; --c2: #d97706; }
  .etm-item[data-act="locate"] { --c1: #14b8a6; --c2: #0d9488; }
  .etm-ico { width: 18px; height: 18px; fill: currentColor; pointer-events: none; }
  .etm-item.paused .ico-pause, .etm-item:not(.paused) .ico-resume { display: none; }
  /* 悬停时的小标签 */
  .etm-tip {
    position: absolute; left: 50%; top: calc(100% + 6px); transform: translateX(-50%) translateY(-3px);
    background: rgba(17,24,39,.94); color: #fff; border-radius: 6px; padding: 4px 8px;
    font: 500 11px/1.2 system-ui; white-space: nowrap; box-shadow: 0 4px 12px rgba(0,0,0,.22);
    opacity: 0; pointer-events: none; transition: opacity .14s ease, transform .14s ease;
  }
  .etm-item:hover .etm-tip { opacity: 1; transform: translateX(-50%) translateY(0); }

  .etm-menu.open .etm-item { opacity: 1; transform: translate(var(--tx, 0), var(--ty, 0)) scale(1); pointer-events: auto; }
  /* 展开时按顺序轻微错峰弹出 */
  .etm-menu.open .etm-item:nth-child(1) { transition-delay: 0ms; }
  .etm-menu.open .etm-item:nth-child(2) { transition-delay: 28ms; }
  .etm-menu.open .etm-item:nth-child(3) { transition-delay: 56ms; }
  .etm-menu.open .etm-item:nth-child(4) { transition-delay: 84ms; }
  .etm-item:hover { filter: brightness(1.06); box-shadow: inset 0 1px 0 rgba(255,255,255,.4), 0 10px 22px rgba(15,23,42,.34); z-index: 5; }
  .etm-item:active { transform: translate(var(--tx, 0), var(--ty, 0)) scale(.94); }
  .etm-item.hidden { display: none; }
  /* 提示层必须高于图标与其他菜单项，避免被遮挡 */
  .etm-tip { z-index: 6; }
  /* 位于图标上方的菜单项，提示放到圆钮上方，避免压住主图标 */
  .etm-item.tip-top .etm-tip { top: auto; bottom: calc(100% + 6px); }

  .etm-toast {
    position: absolute; left: 50%; bottom: ${BTN_SIZE + 8}px; transform: translateX(-50%);
    max-width: 220px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    background: rgba(17,24,39,.92); color: #fff; border-radius: 6px; padding: 5px 8px;
    font: 12px/1.3 system-ui; pointer-events: none; opacity: 0; transition: opacity .15s;
  }
  .etm-toast.show { opacity: 1; }
</style>
<div class="etm-dock">
  <div class="etm-menu" role="menu" aria-label="采集助手快捷菜单">
    <button class="etm-item" data-act="collect-here" role="menuitem" aria-label="采集当前分类榜单">
      <svg class="etm-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19h4V9H4zm6 0h4V5h-4zm6 0h4v-7h-4z"/></svg>
      <span class="etm-tip">采集当前榜单</span>
    </button>
    <button class="etm-item" data-act="open" role="menuitem" aria-label="打开控制面板">
      <svg class="etm-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h7v7H4zm9 0h7v7h-7zM4 13h7v7H4zm9 0h7v7h-7z"/></svg>
      <span class="etm-tip">控制面板</span>
    </button>
    <button class="etm-item" data-act="pause" role="menuitem" aria-label="暂停采集">
      <svg class="etm-ico ico-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h3v14H8zm5 0h3v14h-3z"/></svg>
      <svg class="etm-ico ico-resume" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg>
      <span class="etm-tip">暂停采集</span>
    </button>
    <button class="etm-item" data-act="locate" role="menuitem" aria-label="定位 TikTok 工作页">
      <svg class="etm-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2h-1v3h2V2zm0 17h-1v3h2v-3zM2 12v1h3v-2H2zm17 0v1h3v-2h-3zM12 7a5 5 0 100 10 5 5 0 000-10z"/></svg>
      <span class="etm-tip">定位工作页</span>
    </button>
  </div>
  <button class="etm-btn" aria-label="EchoTik 采集助手：待机">
    <span class="etm-ring"></span>
    <span class="etm-label">ET</span>
    <span class="etm-badge"></span>
  </button>
  <div class="etm-toast" aria-live="polite"></div>
</div>`;
    }

    /**
     * 应用保存的位置（默认右下角）
     * @param host 宿主元素
     */
    function applyPosition(host: HTMLElement): void {
      const x = prefs.x ?? window.innerWidth - BTN_SIZE - 24;
      const y = prefs.y ?? window.innerHeight - BTN_SIZE - 80;
      host.style.left = `${x}px`;
      host.style.top = `${y}px`;
      if (prefs.collapsed) btnEl?.classList.add('collapsed');
    }

    /**
     * 保证 Widget 在视口内（resize 后调用）
     */
    function keepInViewport(): void {
      const host = document.getElementById(HOST_ID);
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const size = prefs.collapsed ? 16 : BTN_SIZE;
      const x = Math.min(Math.max(0, rect.left), window.innerWidth - size);
      const y = Math.min(Math.max(0, rect.top), window.innerHeight - size);
      host.style.left = `${x}px`;
      host.style.top = `${y}px`;
    }

    /**
     * 按图标当前位置计算扇形菜单各项偏移：
     * 靠近右半屏向左上/左下展开，靠近左半屏向右上/右下展开
     */
    function layoutMenu(): void {
      if (!dockEl) return;
      const rect = dockEl.getBoundingClientRect();
      // 水平朝向屏幕中心；垂直朝向屏幕中心（顶部向下、底部向上）
      const sx = rect.left > window.innerWidth / 2 ? -1 : 1;
      const vy = rect.top < window.innerHeight / 2 ? 1 : -1;
      const visible = items.filter((it) => !it.classList.contains('hidden'));
      visible.forEach((item, i) => {
        const t = visible.length > 1 ? i / (visible.length - 1) : 0;
        const angle = (Math.PI / 2) * t; // 0° 正竖直到 90° 正水平
        const dx = sx * Math.sin(angle) * FAN_RADIUS;
        const dy = vy * Math.cos(angle) * FAN_RADIUS;
        // 菜单项初始居中于图标，偏移量即扇形位移
        item.style.setProperty('--tx', `${dx}px`);
        item.style.setProperty('--ty', `${dy}px`);
        // 在图标上方时提示向上显示，避免盖住主图标
        item.classList.toggle('tip-top', dy < 0);
      });
    }

    /**
     * 展开扇形菜单
     */
    function openMenu(): void {
      if (!menuEl || suppressOpen) return;
      if (btnEl?.classList.contains('collapsed')) return; // 折叠态不展开
      clearCloseTimer();
      layoutMenu();
      // 先写入偏移再开启动画，形成由图标向外扇出的效果
      requestAnimationFrame(() => menuEl?.classList.add('open'));
      trackPointer(true);
    }

    /**
     * 收起扇形菜单
     */
    function closeMenu(): void {
      if (!menuEl) return;
      clearCloseTimer();
      trackPointer(false);
      menuEl.classList.remove('open');
      items.forEach((it) => {
        it.style.setProperty('--tx', '0px');
        it.style.setProperty('--ty', '0px');
      });
    }

    /**
     * 延迟收起（指针离开图标/菜单时调用）
     */
    function scheduleClose(): void {
      clearCloseTimer();
      closeTimer = setTimeout(() => {
        closeMenu();
        suppressOpen = false;
        closeTimer = null;
      }, CLOSE_DELAY_MS);
    }

    /**
     * 清理收起定时器
     */
    function clearCloseTimer(): void {
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
    }

    /**
     * 悬停展开/移开收回
     * 菜单项是 dock 的子元素，移入菜单不会触发收回；
     * 另外在菜单展开期间监听全局指针，指针落到 widget 之外立即（延迟）收回
     */
    function bindHover(): void {
      if (!dockEl) return;
      dockEl.addEventListener('pointerenter', () => {
        clearCloseTimer();
        openMenu();
      });
      dockEl.addEventListener('pointerleave', () => {
        scheduleClose();
      });
      // 指针移出浏览器窗口/文档时也收回
      window.addEventListener('blur', () => closeMenu());
      document.addEventListener('pointerleave', () => scheduleClose());
    }

    /**
     * 全局指针移动：菜单展开时检测是否仍在 widget 内，否则安排收回
     * @param e 指针事件（closed shadow 下事件会重定向到宿主元素）
     */
    function onDocumentPointerMove(e: PointerEvent): void {
      if (!hostEl || !dockEl) return;
      if (e.composedPath().includes(hostEl)) return;
      // 扇形展开区域（图标到菜单项半径 + 余量）内不收回，避免从图标移向菜单项途中误收起
      const rect = dockEl.getBoundingClientRect();
      const dist = Math.hypot(e.clientX - (rect.left + rect.width / 2), e.clientY - (rect.top + rect.height / 2));
      if (dist <= FAN_RADIUS + ITEM_SIZE / 2 + 16) return;
      scheduleClose();
    }

    /**
     * 开始/停止全局指针跟踪（仅在菜单展开期间监听，避免常驻开销）
     * @param enable 是否启用
     */
    function trackPointer(enable: boolean): void {
      if (enable === trackingPointer) return;
      trackingPointer = enable;
      if (enable) document.addEventListener('pointermove', onDocumentPointerMove, true);
      else document.removeEventListener('pointermove', onDocumentPointerMove, true);
    }

    /**
     * 绑定拖拽（Pointer Events）：拖拽不触发点击；松手后边缘吸附并保存位置
     * @param host 宿主元素
     */
    function bindDrag(host: HTMLElement): void {
      if (!btnEl) return;
      let dragging = false;
      let moved = false;
      let startX = 0;
      let startY = 0;
      let baseX = 0;
      let baseY = 0;
      let longPressTimer: ReturnType<typeof setTimeout> | null = null;

      btnEl.addEventListener('pointerdown', (e) => {
        dragging = true;
        moved = false;
        startX = e.clientX;
        startY = e.clientY;
        const rect = host.getBoundingClientRect();
        baseX = rect.left;
        baseY = rect.top;
        btnEl!.setPointerCapture(e.pointerId);
        // 长按 800ms 关闭本站点 Widget
        longPressTimer = setTimeout(() => {
          void savePrefs({ hidden: true });
          host.remove();
        }, 800);
      });
      btnEl.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) + Math.abs(dy) > 6) {
          moved = true;
          if (longPressTimer) clearTimeout(longPressTimer);
          closeMenu();
        }
        if (moved) {
          host.style.left = `${baseX + dx}px`;
          host.style.top = `${baseY + dy}px`;
        }
      });
      btnEl.addEventListener('pointerup', (e) => {
        dragging = false;
        if (longPressTimer) clearTimeout(longPressTimer);
        if (moved) {
          // 边缘吸附：吸附到最近的左右边缘
          const rect = host.getBoundingClientRect();
          const size = prefs.collapsed ? 16 : BTN_SIZE;
          const snapX =
            rect.left + size / 2 < window.innerWidth / 2 ? 12 : window.innerWidth - size - 12;
          const snapY = Math.min(Math.max(12, rect.top), window.innerHeight - size - 12);
          host.style.left = `${snapX}px`;
          host.style.top = `${snapY}px`;
          void savePrefs({ x: snapX, y: snapY });
          e.preventDefault();
          e.stopPropagation();
        }
      });
      // 右键关闭本站点 Widget
      btnEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        void savePrefs({ hidden: true });
        host.remove();
      });
      // 单击：未拖拽时切换菜单（触控板/触屏也可用）
      btnEl.addEventListener('click', (e) => {
        if (moved) {
          moved = false;
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        // 动作后短暂抑制也允许用户主动点击重新展开
        suppressOpen = false;
        if (menuEl?.classList.contains('open')) closeMenu();
        else openMenu();
      });
      // 双击折叠/展开
      btnEl.addEventListener('dblclick', (e) => {
        e.preventDefault();
        const collapsed = !btnEl!.classList.contains('collapsed');
        btnEl!.classList.toggle('collapsed', collapsed);
        if (collapsed) closeMenu();
        void savePrefs({ collapsed });
      });
    }

    /**
     * 绑定菜单按钮动作与站点差异（榜单采集入口仅在 EchoTik 页面显示）
     */
    function bindActions(): void {
      if (!shadow) return;
      const collectItem = shadow.querySelector<HTMLElement>('.etm-item[data-act="collect-here"]');
      if (collectItem && !isEchoTik) collectItem.classList.add('hidden');
      items.forEach((el) => {
        el.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          closeMenu();
          const act = el.dataset['act'] ?? '';
          void handleAction(act);
        });
      });
    }

    /**
     * 快捷动作处理
     * @param act 动作名
     */
    async function handleAction(act: string): Promise<void> {
      suppressOpen = true;
      closeMenu();
      showToast('处理中…');
      try {
        switch (act) {
          case 'collect-here':
            await browser.runtime.sendMessage({ type: 'snapshot.createFromCurrent', payload: {} });
            showToast(isEchoTik ? '已开始采集当前榜单' : '仅 EchoTik 页面支持');
            break;
          case 'open':
            await browser.runtime.sendMessage({ type: 'widget.openDashboard', payload: undefined });
            showToast('已打开控制面板');
            break;
          case 'pause': {
            const paused = !!state?.paused;
            await browser.runtime.sendMessage({
              type: paused ? 'runner.resume' : 'runner.pause',
              payload: undefined,
            });
            showToast(paused ? '已继续采集' : '已暂停采集');
            break;
          }
          case 'locate':
            await browser.runtime.sendMessage({ type: 'widget.locateWorkerTab', payload: undefined });
            showToast('已定位 TikTok 工作页');
            break;
        }
      } catch {
        showToast('操作失败，请稍后重试');
      } finally {
        // 无论指针是否移动，短暂抑制后都恢复正常悬停展开
        setTimeout(() => {
          suppressOpen = false;
        }, CLOSE_DELAY_MS + 120);
      }
    }

    /**
     * 显示短暂反馈（2 秒）
     * @param text 反馈文本
     */
    function showToast(text: string): void {
      const el = shadow?.querySelector<HTMLElement>('.etm-toast');
      if (!el) return;
      el.textContent = text;
      el.classList.add('show');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        el.classList.remove('show');
        toastTimer = null;
      }, 2000);
    }

    /**
     * 按状态渲染按钮颜色、进度环、中心进度与徽标（颜色 + aria 文本双通道）
     */
    function render(): void {
      if (!btnEl || !shadow) return;
      const s = state;
      const running =
        !!s?.active_batch_id && !s?.paused && !s?.waiting_verification;
      const verifying = !!s?.waiting_verification;
      const ranking = !s?.active_batch_id && (s?.progress?.total ?? 0) > 0;
      btnEl.classList.toggle('running', running || ranking);
      btnEl.classList.toggle('verifying', verifying);

      let statusText = '待机';
      if (verifying) statusText = '等待人工验证';
      else if (ranking) statusText = '正在抓取榜单';
      else if (running) statusText = '正在采集';
      else if (s?.paused) statusText = '已暂停';

      const done = s?.progress?.done ?? 0;
      const total = s?.progress?.total ?? 0;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      ringEl?.style.setProperty('--p', `${pct}%`);
      // 中心显示 done/total，直观呈现采集进度
      if (labelEl) labelEl.textContent = total > 0 ? `${done}/${total}` : 'ET';
      btnEl.setAttribute('aria-label', `EchoTik 采集助手：${statusText}，进度 ${done}/${total || '?'}`);

      const badge = badgeEl!;
      badge.className = 'etm-badge';
      if (s?.last_error) badge.classList.add('error');
      else if (total > 0 && done >= total) badge.classList.add('done');

      // 暂停/继续按钮文案与图标随运行状态切换
      const pauseItem = shadow.querySelector<HTMLButtonElement>('.etm-item[data-act="pause"]');
      if (pauseItem) {
        const paused = !!s?.paused;
        pauseItem.classList.toggle('paused', paused);
        pauseItem.setAttribute('aria-label', paused ? '继续采集' : '暂停采集');
        const tip = pauseItem.querySelector('.etm-tip');
        if (tip) tip.textContent = paused ? '继续采集' : '暂停采集';
      }
    }
  },
});
