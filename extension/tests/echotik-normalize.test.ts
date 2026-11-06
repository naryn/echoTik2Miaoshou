/**
 * EchoTik 榜单条目归一化单测（样本字段取自 docs/examples/top-sold.md 真实响应）
 */
import { describe, expect, it } from 'vitest';
import { buildDetailUrl, normalizeRankingItem, NormalizeError } from '../src/modules/echotik/normalize';
import { createEchoTikAdapter } from '../src/modules/echotik/adapter';
import type { RankingQuery } from '../src/shared/types';

const query: RankingQuery = {
  region: 'US',
  rankingType: 'daily',
  rankingVariant: 'top-sold',
  periodStart: '20261103',
  startRank: 1,
  limit: 200,
};

/** 取自 docs/examples/top-sold.md 的真实首条记录（截断嵌套字段） */
const sampleItem = {
  product_id: '1732052189676081387',
  product_name: '[medicube] Smooth & Clear Body Care Set | K-Beauty',
  product_name_slug: 'beauty-personal-care-medicube-smooth-clear-body-care-set',
  product_trans1: '',
  product_trans2: '',
  cover_url: 'https://cdn.echotik.live/xxx/product-cover/884/1732052189676081387_0.webp',
  category: '美妆个护',
  categories: ['美妆个护'],
  region: 'US',
  real_price: '$87.10 - 202.80',
  avg_price: '$93',
  sale_cnt: '8919',
  total_sale_cnt: '59.47万',
  total_gmv_amt: '$82.95万',
  review_count: '3.24万',
  product_rating: '4.6',
  commission: '15%',
  seller: { seller_id: '7592374', seller_name: 'medicube' },
};

describe('normalizeRankingItem', () => {
  it('正确映射真实榜单条目字段', () => {
    const entry = normalizeRankingItem(sampleItem, query, 1);
    expect(entry.external_product_id).toBe('1732052189676081387');
    expect(entry.region).toBe('US');
    expect(entry.title).toContain('medicube');
    expect(entry.rank_position).toBe(1);
    expect(entry.shop?.name).toBe('medicube');
    expect(entry.category).toBe('美妆个护');
    expect(entry.detail_url).toBe('https://www.tiktok.com/shop/pdp/1732052189676081387');
  });

  it('销量/GMV 解析"万"为数值且保留原文', () => {
    const entry = normalizeRankingItem(sampleItem, query, 1);
    expect(entry.sales?.value).toBe(8919);
    expect(entry.gmv?.value).toBe(829500);
    expect(entry.gmv?.raw).toBe('$82.95万');
    expect(entry.gmv?.currency).toBe('USD');
  });

  it('商品 ID 缺失时抛 NormalizeError', () => {
    expect(() => normalizeRankingItem({ product_name: 'x' }, query, 1)).toThrow(NormalizeError);
  });

  it('非 US 地区不生成 pdp URL', () => {
    expect(buildDetailUrl('UK', '123')).toBeUndefined();
    expect(buildDetailUrl('US', '123')).toBe('https://www.tiktok.com/shop/pdp/123');
  });
});

describe('EchoTikAdapter.fetchRankingPage', () => {
  it('按接口实际契约组装参数并解析分页（单页上限 50）', async () => {
    const calls: Array<{ path: string; params: Record<string, string | number> }> = [];
    const fullPage = Array.from({ length: 50 }, (_, i) => ({
      ...sampleItem,
      product_id: `${i}732052189676081387`,
    }));
    const adapter = createEchoTikAdapter({
      async request(path, params) {
        calls.push({ path, params });
        return {
          code: 0,
          msg: 'ok',
          data: fullPage,
          meta: { current_page: 1, last_page: 4, per_page: 50, total: 200 },
        };
      },
    });
    const page = await adapter.fetchRankingPage({ ...query, perPage: 50, sortBy: 'sale_cnt' }, undefined, 1);
    expect(calls[0]?.path).toBe('/api/v1/data/products/leaderboard/top-sold');
    expect(calls[0]?.params).toMatchObject({
      time_type: 'daily',
      time_range: '20261103',
      page: 1,
      // 显式指定单页 50 条（文档示例 per_page=50）
      per_page: 50,
      '__echotik_region': 'US',
      'product_categories[]': '',
      order: 'sale_cnt',
    });
    expect(page.hasMore).toBe(true);
    expect(page.total).toBe(200);
    expect(page.records).toHaveLength(50);
  });

  it('code=401 抛出未授权错误', async () => {
    const adapter = createEchoTikAdapter({
      async request() {
        return { code: 401, msg: 'unauthorized' };
      },
    });
    await expect(adapter.fetchRankingPage(query)).rejects.toThrow(/登录失效|未授权/);
  });

  it('code=100004 视为成功（接口当前成功码）', async () => {
    const adapter = createEchoTikAdapter({
      async request() {
        return { code: 100004, msg: 'ok', data: [sampleItem], meta: { current_page: 1, last_page: 1 } };
      },
    });
    const page = await adapter.fetchRankingPage({ ...query }, undefined, 1);
    expect(page.records).toHaveLength(1);
    expect(page.hasMore).toBe(false);
  });

  it('capabilities 与接口实际能力一致', async () => {
    const adapter = createEchoTikAdapter({ async request() { return {}; } });
    const caps = await adapter.capabilities();
    expect(caps.variants).toEqual(['top-sold', 'hot-sell', 'news-burst', 'products']);
    expect(caps.timeTypes).toEqual(['daily', 'weekly', 'monthly']);
    expect(caps.maxPerPage).toBe(50);
  });

  it('fetchAllRankings 在重复页/无下一页时终止', async () => {
    let page = 0;
    const adapter = createEchoTikAdapter({
      async request() {
        page += 1;
        // 每页返回满页（20 条）且与上一页完全相同 → 触发重复页终止
        const data = Array.from({ length: 20 }, () => sampleItem);
        return {
          code: 0,
          msg: 'ok',
          data,
          meta: { current_page: page, last_page: 10, per_page: 20, total: 500 },
        };
      },
    });
    const result = await adapter.fetchAllRankings({ ...query, limit: 200 });
    expect(result.reason).toBe('DUPLICATE_PAGE');
    expect(result.entries).toHaveLength(1);
  }, 15000);

  it('fetchAllRankings 达到 limit 终止', async () => {
    let page = 0;
    const adapter = createEchoTikAdapter({
      async request() {
        page += 1;
        // 每页返回 5 条（与适配器 per_page 一致）
        const data = Array.from({ length: 5 }, (_, i) => ({
          ...sampleItem,
          product_id: `${page}${i}732052189676081387`,
        }));
        return {
          code: 0,
          msg: 'ok',
          data,
          meta: { current_page: page, last_page: 99, per_page: 5, total: 999 },
        };
      },
    });
    const result = await adapter.fetchAllRankings({ ...query, limit: 5 });
    expect(result.reason).toBe('REACHED_LIMIT');
    expect(result.entries).toHaveLength(5);
    expect(result.entries[0]?.rank_position).toBe(1);
    expect(result.entries[4]?.rank_position).toBe(5);
  }, 15000);

  it('单页数据不足 perPage 时不再请求下一页', async () => {
    let calls = 0;
    const adapter = createEchoTikAdapter({
      async request() {
        calls += 1;
        const data = Array.from({ length: 5 }, (_, i) => ({
          ...sampleItem,
          product_id: `${i}732052189676081387`,
        }));
        return {
          code: 0,
          msg: 'ok',
          data,
          meta: { current_page: 1, last_page: 10, per_page: 20, total: 200 },
        };
      },
    });
    const result = await adapter.fetchAllRankings({ ...query, perPage: 20, limit: 100 });
    expect(result.reason).toBe('NO_MORE_PAGES');
    expect(result.entries).toHaveLength(5);
    expect(calls).toBe(1);
  }, 15000);

  it('fetchAllRankings 翻页遇会员权限限制时保留已抓数据并正常结束', async () => {
    let page = 0;
    const adapter = createEchoTikAdapter({
      async request() {
        page += 1;
        // 前 2 页正常返回，第 3 页起接口返回会员限制页（模拟免费/访客套餐翻页上限）
        if (page <= 2) {
          const data = Array.from({ length: 10 }, (_, i) => ({
            ...sampleItem,
            product_id: `${page}${i}732052189676081387`,
          }));
          return {
            code: 0,
            msg: 'ok',
            data,
            meta: { current_page: page, last_page: 20, per_page: 10, total: 200 },
          };
        }
        throw Object.assign(new Error('会员权限限制'), { code: 'ECHOTIK_PERMISSION_LIMIT' });
      },
    });
    const result = await adapter.fetchAllRankings({ ...query, perPage: 10, limit: 200 });
    expect(result.reason).toBe('PERMISSION_LIMIT');
    expect(result.entries).toHaveLength(20);
  }, 15000);
});
