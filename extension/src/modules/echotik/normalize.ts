/**
 * EchoTik 榜单条目归一化：将 docs/interface/*.md 定义的原始字段
 * 映射为 ProductRankingEntry（external_product_id 字符串、销量/GMV 解析、排名位置）
 */
import type { ProductRankingEntry, RankingQuery, RawRankingItem } from '@/shared/types/domain';
import { extractProductId, parseQuantity } from './units';

/** 归一化失败（商品 ID 缺失等）时抛出的错误 */
export class NormalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NormalizeError';
  }
}

/**
 * 生成 TikTok 商品详情 URL（优先接口给出的合法 URL，否则按 US 模板拼接）
 * 注意：规范 §4.3 —— 不能假定所有地区模板可访问，仅 US 使用 pdp 模板
 * @param region 站点
 * @param productId 商品 ID
 */
export function buildDetailUrl(region: string, productId: string): string | undefined {
  if (region.toUpperCase() === 'US') {
    return `https://www.tiktok.com/shop/pdp/${productId}`;
  }
  return undefined;
}

/**
 * 将原始榜单条目归一化为 ProductRankingEntry
 * @param item 原始条目（EchoTik data 数组元素）
 * @param query 当前查询（提供 region 兜底）
 * @param rankPosition 榜单排名（1 起）
 */
export function normalizeRankingItem(
  item: RawRankingItem,
  query: RankingQuery,
  rankPosition: number,
): ProductRankingEntry {
  const productId = extractProductId(item);
  if (!productId) {
    throw new NormalizeError(`条目缺少合法 product_id: ${JSON.stringify(item).slice(0, 120)}`);
  }
  const region =
    typeof item['region'] === 'string'
      ? (item['region'] as string)
      : typeof item['region'] === 'object' && item['region'] !== null
        ? String((item['region'] as Record<string, unknown>)['id'] ?? query.region)
        : query.region;
  const title =
    (item['product_name'] as string | undefined) ||
    (item['product_title'] as string | undefined) ||
    '';
  // seller 可能是对象，也可能直接是 "N/A" 之类的字符串
  const sellerRaw = item['seller'];
  const seller =
    typeof sellerRaw === 'object' && sellerRaw !== null
      ? (sellerRaw as Record<string, unknown>)
      : undefined;
  const sales = parseQuantity((item['sale_cnt'] as string) ?? (item['total_sale_nd_cnt'] as string));
  const gmv = parseQuantity(
    (item['total_gmv_amt'] as string) ?? (item['total_sale_gmv_nd_amt'] as string),
  );

  return {
    external_product_id: productId,
    region,
    title,
    shop: seller
      ? {
          id: seller['seller_id'] as string | undefined,
          name: seller['seller_name'] as string | undefined,
        }
      : undefined,
    rank_position: rankPosition,
    sales,
    gmv,
    image_url: item['cover_url'] as string | undefined,
    category: item['category'] as string | undefined,
    detail_url: buildDetailUrl(region, productId),
    metrics: {
      total_sale_cnt: item['total_sale_cnt'],
      review_count: item['review_count'],
      product_rating: item['product_rating'],
      commission: item['commission'],
    },
    observed_at: new Date().toISOString(),
  };
}
