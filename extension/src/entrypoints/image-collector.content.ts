/**
 * 网页图片收集入口：在任意网页的图片右上角叠加「上传到服务端」按钮
 * - 仅对管理员（identity_role=ADMIN 且已授权）注入，普通用户看不到按钮
 * - 单层固定覆盖层（pointer-events: none），按钮按图片视口坐标定位
 * - IntersectionObserver 只跟踪可见图片；scroll / resize / MutationObserver 触发下一帧重排
 * - 点击后把图片地址交给 background 下载字节并写入服务端 collected_images
 * - 小于 48px 的图片不注入，避免图标、间距图干扰阅读
 */
import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { sendMsg } from '@/shared/messaging';

/** 覆盖层宿主元素 id（避免同一页面重复注入） */
const HOST_ID = 'tk-image-collector-host';
/** 触发按钮的最小图片边长（px） */
const MIN_IMAGE_SIZE = 48;
/** 按钮尺寸（px） */
const BUTTON_SIZE = 20;
/** 单页最多跟踪的图片数量，避免超大页面卡顿 */
const MAX_IMAGES = 800;

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  async main() {
    // 权限门禁：仅管理员且已授权时注入；插件版本落后于服务端时同样不注入
    const auth = await browser.storage.local.get(['identity_role', 'auth_token', 'update_notice']);
    if (auth.identity_role !== 'ADMIN' || !auth.auth_token) return;
    if (auth.update_notice) return;

    // 同一页面只注入一次
    if (document.getElementById(HOST_ID)) return;

    /** 图片元素 -> 上传按钮 */
    const entries = new Map<HTMLImageElement, HTMLButtonElement>();
    let rafId = 0;
    let scanQueued = false;
    let toastTimer: number | null = null;
    let disposed = false;

    // ---- 覆盖层（Shadow DOM 隔离，样式用内联写法规避站点 CSP） ----
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';

    const shadow = host.attachShadow({ mode: 'open' });

    const layerEl = document.createElement('div');
    layerEl.style.cssText = 'position:absolute;inset:0;pointer-events:none;';

    const toastEl = document.createElement('div');
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    toastEl.style.cssText = [
      'position:fixed',
      'left:50%',
      'bottom:32px',
      'transform:translateX(-50%)',
      'max-width:70vw',
      'padding:8px 14px',
      'border-radius:8px',
      'background:rgba(17,24,39,.92)',
      'color:#fff',
      'font:12px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif',
      'box-shadow:0 4px 16px rgba(0,0,0,.3)',
      'opacity:0',
      'transition:opacity .18s ease',
      'pointer-events:none',
      'z-index:1',
    ].join(';');

    shadow.append(layerEl, toastEl);
    document.documentElement.appendChild(host);

    /**
     * 显示底部提示条（3 秒后自动淡出）
     * @param text 提示文案
     */
    function toast(text: string): void {
      toastEl.textContent = text;
      toastEl.style.opacity = '1';
      if (toastTimer !== null) window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => {
        toastEl.style.opacity = '0';
      }, 3000);
    }

    /**
     * 上传单张图片：background 负责下载图片字节并写入服务端
     * @param img 图片元素
     * @param btn 触发上传的按钮
     * @param after 上传结束后的回调（用于恢复按钮悬停可见状态）
     */
    async function upload(
      img: HTMLImageElement,
      btn: HTMLButtonElement,
      after?: () => void,
    ): Promise<void> {
      const url = img.currentSrc || img.src;
      if (!url || !/^(https?:|data:)/i.test(url)) {
        toast('该图片地址不支持上传');
        return;
      }
      if (btn.disabled) return;
      btn.disabled = true;
      const originalColor = btn.style.background;
      btn.style.background = '#6b7280';
      try {
        const res = await sendMsg('product.collectImage', {
          source_url: url,
          title: (img.alt || document.title || '').slice(0, 512),
        });
        toast(res.deduped ? '该图片此前已上传过，无需重复上传' : '图片已上传到服务端');
      } catch (e) {
        toast(`上传失败：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        btn.disabled = false;
        btn.style.background = originalColor || '#2563eb';
        after?.();
      }
    }

    /**
     * 生成图片右上角的上传按钮
     * @param img 目标图片
     */
    function createButton(img: HTMLImageElement): HTMLButtonElement {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.title = '上传图片到服务端';
      btn.setAttribute('aria-label', '上传图片到服务端');
      btn.style.cssText = [
        'position:absolute',
        'left:0',
        'top:0',
        'width:20px',
        'height:20px',
        'padding:0',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'border:1px solid #fff',
        'border-radius:999px',
        'background:#2563eb',
        'color:#fff',
        'box-shadow:0 1px 4px rgba(0,0,0,.4)',
        'cursor:pointer',
        'pointer-events:none',
        'opacity:0',
        'transition:opacity .12s ease',
      ].join(';');
      btn.innerHTML =
        '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
        '<path d="M8 10V3m0 0L5.5 5.5M8 3l2.5 2.5M3 10.5V12a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5v-1.5" ' +
        'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

      /** 指针/焦点是否停留在图片或按钮上 */
      let inside = false;
      let hideTimer: number | null = null;

      /**
       * 切换按钮可见性；隐藏时同时关闭指针事件，避免透明按钮挡住图片点击
       * @param visible 是否显示
       */
      function setVisible(visible: boolean): void {
        btn.style.opacity = visible ? '1' : '0';
        btn.style.pointerEvents = visible ? 'auto' : 'none';
      }

      /** 鼠标移入图片或按钮：立即显示上传按钮 */
      function show(): void {
        inside = true;
        if (hideTimer !== null) {
          window.clearTimeout(hideTimer);
          hideTimer = null;
        }
        setVisible(true);
      }

      /** 鼠标移出图片或按钮：延迟隐藏，留出移动到按钮的时间 */
      function hide(): void {
        inside = false;
        if (hideTimer !== null) window.clearTimeout(hideTimer);
        hideTimer = window.setTimeout(() => {
          hideTimer = null;
          if (!inside && !btn.disabled) setVisible(false);
        }, 150);
      }

      img.addEventListener('mouseenter', show);
      img.addEventListener('mouseleave', hide);
      btn.addEventListener('mouseenter', show);
      btn.addEventListener('mouseleave', hide);
      btn.addEventListener('focus', show);
      btn.addEventListener('blur', hide);
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void upload(img, btn, () => {
          if (!inside && !btn.disabled) setVisible(false);
        });
      });
      return btn;
    }

    /**
     * 按视口坐标重排按钮；不可见或过小的图片隐藏按钮
     */
    function sync(): void {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      entries.forEach((btn, img) => {
        const rect = img.getBoundingClientRect();
        const visible =
          img.isConnected &&
          rect.width >= MIN_IMAGE_SIZE &&
          rect.height >= MIN_IMAGE_SIZE &&
          rect.bottom > 0 &&
          rect.top < vh &&
          rect.right > 0 &&
          rect.left < vw;
        if (!visible) {
          btn.style.display = 'none';
          btn.style.opacity = '0';
          btn.style.pointerEvents = 'none';
          return;
        }
        btn.style.display = 'flex';
        // 贴图片右上角内侧，避免被页面滚动容器裁切
        const x = Math.min(rect.right - BUTTON_SIZE - 4, vw - BUTTON_SIZE - 4);
        const y = Math.max(rect.top + 4, 4);
        btn.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      });
    }

    /** 下一帧统一重排，避免滚动时高频计算 */
    function schedule(): void {
      if (disposed || rafId) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        if (disposed) return;
        sync();
      });
    }

    /**
     * 注册图片：创建按钮并开始观察可见性
     * @param img 图片元素
     */
    function register(img: HTMLImageElement): void {
      if (entries.has(img) || entries.size >= MAX_IMAGES) return;
      const btn = createButton(img);
      layerEl.appendChild(btn);
      entries.set(img, btn);
      io.observe(img);
      schedule();
    }

    /**
     * 扫描页面中的图片（含新插入的节点）
     * @param root 扫描根节点
     */
    function scan(root: ParentNode = document): void {
      root.querySelectorAll('img').forEach((node) => register(node as HTMLImageElement));
    }

    const io = new IntersectionObserver(() => schedule(), {
      threshold: [0, 0.01, 0.5, 1],
    });

    // 滚动 / 窗口尺寸变化：下一帧重排
    window.addEventListener('scroll', schedule, { passive: true, capture: true });
    window.addEventListener('resize', schedule, { passive: true });

    // DOM 变化（懒加载、瀑布流、SPA 路由）：每帧最多补扫一次
    const mo = new MutationObserver(() => {
      if (scanQueued) return;
      scanQueued = true;
      window.requestAnimationFrame(() => {
        scanQueued = false;
        scan(document);
        schedule();
      });
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    scan(document);
    schedule();

    // 账号被降级或顶下线时立即移除按钮（重新以管理员登录后再刷新页面即可恢复）
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (!changes.identity_role && !changes.auth_token) return;
      void browser.storage.local.get(['identity_role', 'auth_token']).then((now) => {
        if (now.identity_role === 'ADMIN' && now.auth_token) return;
        disposed = true;
        mo.disconnect();
        io.disconnect();
        window.removeEventListener('scroll', schedule, true);
        window.removeEventListener('resize', schedule);
        entries.clear();
        host.remove();
      });
    });
  },
});
