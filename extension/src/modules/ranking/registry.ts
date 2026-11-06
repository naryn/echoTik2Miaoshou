/**
 * 榜单适配器注册表
 *
 * 新增数据来源平台时，只需：
 * 1. 在 shared/types/domain.ts 的 RANKING_SOURCES 追加标识；
 * 2. 在 modules/ranking/sources.ts 补一条元信息；
 * 3. 在这里加一个 case 与对应适配器工厂。
 * 其余链路（快照、批次、本地商品、UI）都按 source 字段自动适配。
 */
import type { IRankingAdapter, RankingQuery, RankingSource, CategoryNode } from '@/shared/types';
import { createEchoTikAdapter, type EchoTikTransport } from '@/modules/echotik/adapter';
import { createFastMossAdapter, type FastMossTransport } from '@/modules/fastmoss/adapter';

/** 各来源平台所需的传输层（由 background 按 Tab 创建） */
export interface RankingTransports {
  echotik: EchoTikTransport;
  fastmoss: FastMossTransport;
}

/**
 * 按来源平台创建适配器
 * @param source 来源平台
 * @param transports 各平台传输层
 */
export function createRankingAdapter(source: RankingSource, transports: RankingTransports): IRankingAdapter {
  switch (source) {
    case 'FASTMOSS':
      return createFastMossAdapter(transports.fastmoss);
    case 'ECHOTIK':
    default:
      return createEchoTikAdapter(transports.echotik);
  }
}

/**
 * 解析查询条件中的来源平台（缺省 EchoTik）
 * @param query 查询条件
 */
export function resolveSource(query: Pick<RankingQuery, 'source'>): RankingSource {
  return query.source ?? 'ECHOTIK';
}

/**
 * 平台品类树：仅 EchoTik 提供，其余平台返回空数组
 * 保持统一入口，避免调用方按平台写分支
 * @param source 来源平台
 * @param transports 传输层
 * @param lang 语言
 */
export async function fetchSourceCategories(
  source: RankingSource,
  transports: RankingTransports,
  lang?: 'zh-CN' | 'en',
): Promise<CategoryNode[]> {
  const adapter = createRankingAdapter(source, transports);
  return adapter.fetchCategories(lang).catch(() => []);
}
