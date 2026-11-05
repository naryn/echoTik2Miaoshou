/**
 * 数量单位解析单测（"万"/"亿"/货币/千分位/空值）
 */
import { describe, expect, it } from 'vitest';
import { extractProductId, parseQuantity } from '../src/modules/echotik/units';

describe('parseQuantity', () => {
  it('解析纯数字', () => {
    expect(parseQuantity('8919')).toEqual({ value: 8919, raw: '8919', currency: undefined });
  });

  it('解析"万"单位', () => {
    expect(parseQuantity('59.47万').value).toBe(594700);
    expect(parseQuantity('59.47万').raw).toBe('59.47万');
    expect(parseQuantity('3.24万').value).toBe(32400);
  });

  it('解析"亿"单位', () => {
    expect(parseQuantity('5.55亿').value).toBe(555000000);
  });

  it('解析美元金额带单位', () => {
    const r = parseQuantity('$82.95万');
    expect(r.value).toBe(829500);
    expect(r.currency).toBe('USD');
  });

  it('解析人民币金额', () => {
    const r = parseQuantity('¥620.4');
    expect(r.value).toBeCloseTo(620.4);
    expect(r.currency).toBe('CNY');
  });

  it('解析千分位', () => {
    expect(parseQuantity('1,234,567').value).toBe(1234567);
  });

  it('空值与占位符返回 null', () => {
    expect(parseQuantity('').value).toBeNull();
    expect(parseQuantity(null).value).toBeNull();
    expect(parseQuantity(undefined).value).toBeNull();
    expect(parseQuantity('-').value).toBeNull();
  });

  it('非法数字返回 null 但保留原文', () => {
    const r = parseQuantity('约一万');
    expect(r.value).toBeNull();
    expect(r.raw).toBe('约一万');
  });
});

describe('extractProductId', () => {
  it('字符串 ID 原样返回', () => {
    expect(extractProductId({ product_id: '1732052189676081387' })).toBe('1732052189676081387');
  });

  it('缺失时返回 null', () => {
    expect(extractProductId({})).toBeNull();
    expect(extractProductId({ product_id: '' })).toBeNull();
  });
});
