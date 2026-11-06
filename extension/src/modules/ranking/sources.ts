/**
 * 榜单数据来源平台注册表（元信息）
 *
 * 新增平台只需在此追加一条 meta，并在 registry.ts 注册对应适配器工厂；
 * UI 的平台下拉、Tab 定位、登录检测都从这里读取，避免各处硬编码域名。
 */
import type { RankingSource } from '@/shared/types/domain';

/** 来源平台元信息 */
export interface RankingSourceMeta {
  id: RankingSource;
  /** 展示名 */
  label: string;
  /** 带登录态的主域（Host-only Cookie 仅挂在这里） */
  origin: string;
  /** 用户需要打开的榜单页 */
  boardUrl: string;
  /** chrome.tabs.query 的 url 匹配模式 */
  tabUrlPatterns: string[];
  /** 该平台是否提供榜单数据（false 表示尚未接入，UI 置灰） */
  available: boolean;
  /** 未接入时的说明 */
  unavailableReason?: string;
}

/** 已注册的来源平台 */
export const RANKING_SOURCE_META: Record<RankingSource, RankingSourceMeta> = {
  ECHOTIK: {
    id: 'ECHOTIK',
    label: 'EchoTik',
    origin: 'https://echotik.live',
    boardUrl: 'https://echotik.live/board',
    tabUrlPatterns: ['https://echotik.live/*', 'https://*.echotik.live/*'],
    available: true,
  },
  FASTMOSS: {
    id: 'FASTMOSS',
    label: 'FastMoss',
    origin: 'https://www.fastmoss.com',
    // 实测有效榜单页：销量榜 /e-commerce/saleslist，新品榜 /e-commerce/newProducts，热推榜 /e-commerce/hotlist
    // 注意 /e-commerce/rank 不存在（只返回风控脚本）
    boardUrl: 'https://www.fastmoss.com/e-commerce/saleslist',
    tabUrlPatterns: ['https://www.fastmoss.com/*', 'https://*.fastmoss.com/*'],
    available: true,
  },
};

/**
 * 读取来源平台元信息
 * @param source 来源平台（未传时默认 EchoTik）
 */
export function sourceMeta(source: RankingSource | undefined): RankingSourceMeta {
  return RANKING_SOURCE_META[source ?? 'ECHOTIK'];
}
