/**
 * api client buildQueryString 单测（查询类消息路由透传的 URL 构造）
 */
import { describe, expect, it } from 'vitest';
import { buildQueryString } from '../src/modules/api/client';
import { BatchItemSchema } from '../src/shared/types/remote';

describe('BatchItemSchema', () => {
  it('兼容服务端 created=布尔值、幂等重放 skipped=null', () => {
    const parsed = BatchItemSchema.safeParse({
      batch_id: 'b1',
      status: 'READY',
      created: true,
      skipped_already_successful: null,
    });
    expect(parsed.success).toBe(true);
  });
});

describe('buildQueryString', () => {
  it('空参数返回空串', () => {
    expect(buildQueryString({})).toBe('');
  });

  it('跳过 undefined / null / 空字符串', () => {
    expect(buildQueryString({ a: undefined, b: null, c: '' })).toBe('');
  });

  it('拼接数字与字符串参数', () => {
    const qs = buildQueryString({ page: 2, per_page: 50, status: 'FAILED' });
    expect(qs).toBe('?page=2&per_page=50&status=FAILED');
  });

  it('布尔值与 0 保留', () => {
    const qs = buildQueryString({ exclude_already_successful: true, rank_min: 0 });
    expect(qs).toBe('?exclude_already_successful=true&rank_min=0');
  });

  it('特殊字符 URL 编码', () => {
    const qs = buildQueryString({ keyword: 'a b&c' });
    expect(qs).toBe('?keyword=a+b%26c');
  });
});
