/**
 * FastMoss 榜单条目归一化
 *
 * FastMoss 的接口字段名未公开且可能随版本变化，因此这里不写死单一字段名，
 * 而是按「别名优先级」在对象上做多候选探测（含嵌套一层），并兼容
 * "10K / 1.2M / $19.99 / 1,234" 这类展示态数值。
 *
 * 归一化结果与 EchoTik 适配器保持同一结构（ProductRankingEntry），
 * 这样上传、入库、批次创建等下游逻辑完全复用。
 */
import type { ProductRankingEntry, RawRankingItem } from '@/shared/types/domain';

/** 字段别名表（优先级从高到低；前几项为 FastMoss 实测字段） */
const FIELD_ALIASES = {
  id: ['product_id', 'productId', 'item_id', 'itemId', 'aweme_id', 'awemeId', 'pid', 'id'],
  title: ['title', 'product_title', 'productTitle', 'product_name', 'productName', 'name', 'desc'],
  image: ['cover', 'cover_url', 'coverUrl', 'image_url', 'imageUrl', 'image', 'img', 'main_image', 'mainImage'],
  price: ['real_price', 'price', 'sale_price', 'salePrice', 'min_price', 'minPrice', 'price_value', 'priceValue'],
  sales: [
    // 优先数值字段（show 字段为「9.72万」这类展示态，精度低）
    'sold_count',
    'soldCount',
    'sold_count_show',
    'soldCountShow',
    'sales',
    'sale_cnt',
    'saleCnt',
    'sales_volume',
    'salesVolume',
    'units_sold',
    'unitsSold',
  ],
  gmv: [
    'sale_amount',
    'saleAmount',
    'sale_amount_show',
    'saleAmountShow',
    'gmv',
    'gmv_amount',
    'gmvAmount',
    'revenue',
    'sales_amount',
    'salesAmount',
    'amount',
  ],
  shopId: ['seller_id', 'sellerId', 'shop_id', 'shopId', 'store_id', 'storeId'],
  shopName: ['name', 'seller_name', 'sellerName', 'shop_name', 'shopName', 'store_name', 'storeName', 'brand_name', 'brandName'],
  category: [
    'all_category_name',
    'allCategoryName',
    'category_name',
    'categoryName',
    'category',
    'cate_name',
    'cateName',
  ],
  detailUrl: ['detail_url', 'detailUrl', 'product_url', 'productUrl', 'url', 'link'],
  rank: ['rank', 'ranking', 'rank_position', 'rankPosition', 'position', 'rank_no', 'rankNo'],
  region: ['region', 'country', 'country_code', 'countryCode', 'market'],
} as const;

/** 把未知值转成对象（数组取第一个元素） */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    const first = value.find((v) => v && typeof v === 'object');
    return first ? (first as Record<string, unknown>) : null;
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/**
 * 按别名表读取字段：先在对象浅层找，再尝试一层嵌套对象（如 product/shop/stats）
 * @param obj 原始条目
 * @param aliases 别名数组
 */
function pick(obj: Record<string, unknown>, aliases: readonly string[]): unknown {
  for (const key of aliases) {
    const v = obj[key];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  for (const nestedKey of ['shop_info', 'shopInfo', 'product', 'item', 'goods', 'basic', 'stats', 'statistics', 'shop', 'seller']) {
    const nested = asRecord(obj[nestedKey]);
    if (!nested) continue;
    for (const key of aliases) {
      const v = nested[key];
      if (v !== undefined && v !== null && v !== '') return v;
    }
  }
  return undefined;
}

/**
 * 解析展示态数值：支持 1,234 / 10K / 1.2M / 3.4B / $19.99 / 12.5%
 * @param value 原始值
 */
export function parseMetric(value: unknown): { value: number; raw: string } | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { value, raw: String(value) };
  }
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  const m = raw.replace(/,/g, '').match(/-?\d+(?:\.\d+)?\s*([KkMmBb]|千|万|亿)?/);
  if (!m) return undefined;
  const num = Number(m[0].replace(/[^\d.]/g, ''));
  if (!Number.isFinite(num)) return undefined;
  const unit = (m[1] ?? '').toLowerCase();
  const scale =
    unit === 'k' || unit === '千' ? 1e3 : unit === 'm' || unit === '万' ? 1e4 : unit === 'b' || unit === '亿' ? 1e8 : 1;
  // 注意：M 在英文语境是百万，万是中文语境；这里统一按百万处理更贴近销量展示
  const fixedScale = unit === 'm' ? 1e6 : unit === '万' ? 1e4 : scale;
  return { value: num * fixedScale, raw };
}

/**
 * 把任意字段值转成展示文本
 * - 字符串/数字直接转换
 * - 数组（如 FastMoss 的 all_category_name: ['食品饮料','零食','糖果']）按层级拼接
 * @param value 原始值
 */
function toText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim());
    return parts.length ? parts.join(' / ') : undefined;
  }
  return undefined;
}

/** 字符串字段读取（兼容数组型字段） */
function pickString(obj: Record<string, unknown>, aliases: readonly string[]): string | undefined {
  return toText(pick(obj, aliases));
}

/**
 * 判断一个对象是否像商品条目（必须能拿到商品 ID）
 * @param candidate 候选对象
 */
export function looksLikeProduct(candidate: unknown): candidate is Record<string, unknown> {
  const obj = asRecord(candidate);
  if (!obj) return false;
  const id = pick(obj, FIELD_ALIASES.id);
  if (id === undefined) return false;
  const idStr = String(id);
  return /^\d{6,}$/.test(idStr) || idStr.length >= 6;
}

/**
 * 在任意 JSON 中递归找出商品数组（FastMoss 返回结构未公开，做结构无关提取）
 * @param payload 接口响应
 * @param maxDepth 递归深度上限
 */
export function extractProductItems(payload: unknown, maxDepth = 6): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const seenObjects = new Set<unknown>();
  const walk = (node: unknown, depth: number): void => {
    if (depth > maxDepth || node == null) return;
    if (Array.isArray(node)) {
      const products = node.filter(looksLikeProduct);
      if (products.length) found.push(...products);
      else node.slice(0, 20).forEach((child) => walk(child, depth + 1));
      return;
    }
    const obj = asRecord(node);
    if (!obj || seenObjects.has(obj)) return;
    seenObjects.add(obj);
    if (looksLikeProduct(obj)) {
      found.push(obj);
      return;
    }
    for (const value of Object.values(obj)) walk(value, depth + 1);
  };
  walk(payload, 0);
  return found;
}

/**
 * 构造 TikTok Shop 商品链接（新品榜接口不返回 detail_url，用 product_id + region 拼出）
 * @param id 商品 ID
 * @param region 站点
 */
function buildDetailUrl(id: string, region: string): string | undefined {
  if (!/^\d{6,}$/.test(id)) return undefined;
  const q = region ? `?region=${encodeURIComponent(region)}&local=en` : '';
  return `https://shop.tiktok.com/view/product/${id}${q}`;
}

/**
 * 把 FastMoss 原始条目归一化为统一榜单条目
 * @param item 原始条目
 * @param region 回填站点
 * @param rankPosition 榜单名次
 */
export function normalizeFastMossItem(
  item: RawRankingItem,
  region: string,
  rankPosition: number,
): ProductRankingEntry {
  const obj = asRecord(item) ?? {};
  const id = String(pick(obj, FIELD_ALIASES.id) ?? '');
  const price = parseMetric(pick(obj, FIELD_ALIASES.price));
  const sales = parseMetric(pick(obj, FIELD_ALIASES.sales));
  const gmv = parseMetric(pick(obj, FIELD_ALIASES.gmv));
  const rankValue = parseMetric(pick(obj, FIELD_ALIASES.rank));
  return {
    external_product_id: id,
    region: pickString(obj, FIELD_ALIASES.region) ?? region,
    title: pickString(obj, FIELD_ALIASES.title) ?? '',
    shop: {
      id: pickString(obj, FIELD_ALIASES.shopId),
      name: pickString(obj, FIELD_ALIASES.shopName),
    },
    rank_position: rankValue?.value ?? rankPosition,
    sales,
    gmv,
    image_url: pickString(obj, FIELD_ALIASES.image),
    category: pickString(obj, FIELD_ALIASES.category),
    // 实测 detail_url 为 TikTok Shop 商品链接，可直接用于妙手采集
    detail_url: pickString(obj, FIELD_ALIASES.detailUrl) ?? buildDetailUrl(id, pickString(obj, FIELD_ALIASES.region) ?? region),
    metrics: price ? { price: price.value } : undefined,
    observed_at: new Date().toISOString(),
  };
}
