/**
 * 管理台页面共享工具：时间格式化、状态徽标、错误分类提示（规范 §3.9）
 */

/**
 * 格式化 ISO 时间为本地可读字符串（空值返回占位符）
 * @param iso ISO 时间字符串
 */
export function formatTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 格式化毫秒耗时
 * @param ms 毫秒
 */
export function formatElapsed(ms?: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 状态对应的徽标样式类
 * @param status 批次/任务/快照状态
 */
export function statusBadgeClass(status?: string | null): string {
  switch (status) {
    case 'SUCCESS':
    case 'COMPLETED':
      return 'badge ok';
    case 'RUNNING':
    case 'LEASED':
    case 'NAVIGATING':
    case 'PAGE_READY':
    case 'SUBMITTING':
    case 'SUBMITTED':
    case 'RECOVERING':
      return 'badge run';
    case 'FAILED':
    case 'CANCELLED':
      return 'badge err';
    case 'UNKNOWN':
    case 'PARTIAL':
    case 'COMPLETED_WITH_ERRORS':
    case 'WAITING_VERIFICATION':
    case 'PAUSED':
      return 'badge warn';
    case 'READY':
    case 'PENDING':
    case 'DRAFT':
      return 'badge info';
    default:
      return 'badge';
  }
}

/**
 * 状态中文文案
 * @param status 状态枚举
 */
export function statusText(status?: string | null): string {
  const map: Record<string, string> = {
    DRAFT: '草稿',
    READY: '待运行',
    RUNNING: '运行中',
    PAUSED: '已暂停',
    WAITING_VERIFICATION: '等待验证',
    RECOVERING: '恢复中',
    COMPLETED: '已完成',
    COMPLETED_WITH_ERRORS: '完成(有错误)',
    CANCELLED: '已取消',
    PENDING: '待处理',
    LEASED: '已领取',
    NAVIGATING: '导航中',
    PAGE_READY: '页面就绪',
    SUBMITTING: '提交中',
    SUBMITTED: '已提交',
    SUCCESS: '成功',
    SKIPPED: '已跳过',
    FAILED: '失败',
    UNKNOWN: '不确定',
    PARTIAL: '部分完成',
    NEVER: '未采集',
  };
  return map[status ?? ''] ?? status ?? '—';
}

/**
 * 任务状态文案：对“已采集过的重复商品”给出明确标记
 * @param task 任务（含状态与错误码）
 */
export function taskStatusText(task: { status: string; last_error_code?: string | null }): string {
  if (task.status === 'SKIPPED' && task.last_error_code === 'DUPLICATE_ALREADY_COLLECTED') return '重复抓取';
  return statusText(task.status);
}

/**
 * 将错误对象分类为规范 §3.9 的用户可理解提示
 * @param e 捕获的错误
 */
export function classifyError(e: unknown): { kind: string; text: string } {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('ECHOTIK_PERMISSION_LIMIT')) {
    return {
      kind: 'echotik-permission',
      text: '当前 EchoTik 账号为免费/访客权限，可查看的榜单条数有限；已抓取到的数据会保留并标记为部分完成。',
    };
  }
  if (msg.includes('ECHOTIK_UNAUTHORIZED')) {
    return { kind: 'echotik-auth', text: 'EchoTik 未登录或登录已失效，请在浏览器中登录 echotik.live 后重试。' };
  }
  if (msg.includes('ECHOTIK_BAD_RESPONSE')) {
    // 页面桥/适配器已给出更具体的原因（返回网页、业务码异常）时，直接透出该提示
    if (msg.includes('网页而非数据')) return { kind: 'echotik-html', text: msg.replace(/^[A-Z_]+: /, '') };
    if (msg.includes('返回错误')) return { kind: 'echotik-api', text: msg.replace(/^[A-Z_]+: /, '') };
    return { kind: 'echotik-format', text: 'EchoTik 页面接口格式可能已变化，请更新扩展或联系开发者核对适配器。' };
  }
  if (msg.includes('TIKTOK_ACCESS_RESTRICTED') || msg.includes('ACCESS_RESTRICTED')) {
    return { kind: 'restricted', text: '遇到访问限制，请稍后在页面中人工处理，扩展不会自动绕过。' };
  }
  if (msg.includes('PRODUCT_REGION_UNAVAILABLE')) {
    return {
      kind: 'region-unavailable',
      text: '商品在当前国家/地区不可用（TikTok 提示“此国家或地区未提供”），批次已自动暂停。请确认榜单站点后继续或停止。',
    };
  }
  if (msg.includes('MIAOSHOU_UNAVAILABLE')) {
    return { kind: 'miaoshou', text: '妙手按钮不可用：请确认妙手官方插件已安装并在 TikTok 商品页正常注入。' };
  }
  if (msg.includes('EMPTY_BATCH')) {
    return {
      kind: 'empty-batch',
      text: '该快照没有可用商品明细（可能采集上传失败）：请重新获取并保存榜单后再创建批次。',
    };
  }
  if (msg.includes('BATCH_ALREADY_ACTIVE')) {
    return { kind: 'batch-active', text: '已有进行中的批次，请先在「批次任务」完成或停止它后再创建新批次。' };
  }
  if (msg.includes('SERVER_UNAUTHORIZED') || msg.includes('NOT_REGISTERED')) {
    return { kind: 'server-auth', text: '客户端未注册或凭证失效，请到设置页重新绑定。' };
  }
  if (msg.includes('SERVER_UNREACHABLE') || msg.includes('Failed to fetch') || msg.includes('abort')) {
    return { kind: 'server-offline', text: '远端离线或网络中断，操作未生效；恢复后请重试。' };
  }
  return { kind: 'unknown', text: msg };
}

/**
 * 生成 UUID（幂等键用）
 */
export function uuid(): string {
  return crypto.randomUUID();
}

/**
 * 触发浏览器下载（CSV 导出用）
 * @param filename 文件名
 * @param content 文本内容
 * @param mime MIME 类型
 */
export function downloadText(filename: string, content: string, mime = 'text/csv'): void {
  const blob = new Blob(['﻿' + content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * 将记录数组转为 CSV 文本（首行表头）
 * @param headers 表头
 * @param rows 数据行（与表头等长）
 */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
}
