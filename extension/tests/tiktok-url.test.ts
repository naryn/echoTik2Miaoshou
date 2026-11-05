/**
 * TikTok 商品 URL 解析测试
 * 覆盖真实落地页形态：https://shop.tiktok.com/{region}/pdp/{slug}/{id}
 */
import { describe, expect, it } from 'vitest';
import { extractProductIdFromUrl, isTikTokShopUrl, resolveDetailUrl } from '@/modules/tiktok/tab-manager';

describe('extractProductIdFromUrl', () => {
  it('解析 www.tiktok.com/shop/pdp/{id} 旧形态', () => {
    expect(extractProductIdFromUrl('https://www.tiktok.com/shop/pdp/1732052189676081387')).toBe(
      '1732052189676081387',
    );
  });

  it('解析真实落地页 shop.tiktok.com/{region}/pdp/{slug}/{id}', () => {
    const url =
      'https://shop.tiktok.com/us/pdp/medicube-body-care-set-exfoliating-brightening-k-beauty/1732052189676081387?source=product_detail';
    expect(extractProductIdFromUrl(url)).toBe('1732052189676081387');
  });

  it('解析 shop.tiktok.com/{region}/pdp/{id} 无 slug 形态', () => {
    expect(extractProductIdFromUrl('https://shop.tiktok.com/us/pdp/1732052189676081387')).toBe(
      '1732052189676081387',
    );
  });

  it('查询参数兜底', () => {
    expect(extractProductIdFromUrl('https://shop.tiktok.com/us/search?productId=123456789')).toBe(
      '123456789',
    );
  });

  it('非商品页返回 null', () => {
    expect(extractProductIdFromUrl('https://shop.tiktok.com/us/home')).toBeNull();
  });
});

describe('resolveDetailUrl', () => {
  it('无服务端详情链接时回退到规范模板（含 VN/TH 商品）', () => {
    expect(resolveDetailUrl('1732052189676081387', null)).toBe(
      'https://www.tiktok.com/shop/pdp/1732052189676081387',
    );
  });

  it('有合法服务端详情链接时优先使用', () => {
    expect(resolveDetailUrl('123', 'https://shop.tiktok.com/uk/pdp/a/123')).toBe(
      'https://shop.tiktok.com/uk/pdp/a/123',
    );
  });

  it('服务端链接非法时回退到规范模板', () => {
    expect(resolveDetailUrl('123', 'https://example.com/x')).toBe(
      'https://www.tiktok.com/shop/pdp/123',
    );
  });
});

describe('isTikTokShopUrl', () => {
  it('同时接受 www 与 shop 域名', () => {
    expect(isTikTokShopUrl('https://www.tiktok.com/shop/pdp/1')).toBe(true);
    expect(isTikTokShopUrl('https://shop.tiktok.com/us/pdp/a/2')).toBe(true);
    expect(isTikTokShopUrl('https://www.tiktok.com/@user/video/1')).toBe(false);
    expect(isTikTokShopUrl(undefined)).toBe(false);
  });
});
