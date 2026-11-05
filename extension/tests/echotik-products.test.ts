/**
 * EchoTik 适配器商品库（products）变体测试
 * 验证接口路径、query 参数与无榜单周期行为符合 docs/interface/products.md
 */
import { describe, expect, it, vi } from 'vitest';
import { createEchoTikAdapter } from '../src/modules/echotik/adapter';
import type { RankingQuery } from '../src/shared/types';

/** 构造固定 envelope 响应 */
function envelope(items: Record<string, unknown>[] = []) {
  return {
    code: 0,
    msg: 'ok',
    data: items,
    meta: { current_page: 1, last_page: 1, total: items.length },
  };
}

/** 最小商品库条目（字段取自 products.md） */
const productItem = {
  product_id: '1732052189676081387',
  product_name: 'medicube Smooth & Clear Body Care Set',
  cover_url: 'https://example.com/a.jpg',
  category: '身体护理套装',
  categories: '美妆个护/洗浴与身体护理/身体护理套装',
  region: { id: 'US', name: '美国', key: 'us' },
  total_sale_nd_cnt: '4.13万',
  total_sale_gmv_nd_amt: '$350.75万',
  seller: { seller_id: 's1', seller_name: 'medicube' },
};

describe('adapter products 变体', () => {
  it('走 /api/v1/data/products 且携带 dateRange/sort，无 time_type/time_range', async () => {
    const request = vi.fn(async () => envelope([productItem]));
    const adapter = createEchoTikAdapter({ request } as never);
    const query: RankingQuery = {
      region: 'US',
      categoryId: 'c1',
      rankingType: 'products',
      rankingVariant: 'products',
      dateRange: 30,
      sortBy: 'total_sale_gmv_nd_amt',
      startRank: 1,
      limit: 10,
      perPage: 10,
    };
    await adapter.fetchAllRankings(query);

    const [path, params] = request.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(path).toBe('/api/v1/data/products');
    expect(params['dateRange']).toBe(30);
    expect(params['sort']).toBe('desc');
    expect(params['order']).toBe('total_sale_gmv_nd_amt');
    expect(params['product_categories']).toBe('c1');
    expect(params).not.toHaveProperty('time_type');
    expect(params).not.toHaveProperty('time_range');
  });

  it('归一化使用近 N 天指标与对象形式 region', async () => {
    const request = vi.fn(async () => envelope([productItem]));
    const adapter = createEchoTikAdapter({ request } as never);
    const query: RankingQuery = {
      region: 'US',
      rankingType: 'products',
      rankingVariant: 'products',
      startRank: 1,
      limit: 5,
      perPage: 5,
    };
    const r = await adapter.fetchAllRankings(query);
    const first = r.entries[0]!;
    expect(r.entries).toHaveLength(1);
    expect(first.region).toBe('US');
    expect(first.sales?.value).toBe(41300);
    expect(first.gmv?.value).toBeCloseTo(3507500);
    expect(first.category).toBe('身体护理套装');
  });

  it('capabilities 声明 products 变体与对应排序字段', async () => {
    const adapter = createEchoTikAdapter({ request: vi.fn() } as never);
    const caps = await adapter.capabilities();
    expect(caps.variants).toContain('products');
    expect(caps.orderFields['products']).toContain('total_sale_nd_cnt');
  });
});
