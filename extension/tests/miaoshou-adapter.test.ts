/**
 * 妙手采集按钮适配器测试
 * 重点：真实页面按钮文案常夹带不可见字符（如 U+200E 左右书写标记），
 * 归一化后「采集此商品」必须能匹配（否则点击采集会静默失效）
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MIAOSHOU_SELECTORS, normalizeText } from '@/modules/miaoshou/adapter';

describe('normalizeText', () => {
  it('移除零宽/方向控制字符与空白', () => {
    expect(normalizeText('采\u200E集此商品')).toBe('采集此商品');
    expect(normalizeText(' 采 集 此 商 品 ')).toBe('采集此商品');
    expect(normalizeText('\uFEFF采集此商品\u200B')).toBe('采集此商品');
  });

  it('配置中的文案候选归一化后仍为原文', () => {
    for (const t of DEFAULT_MIAOSHOU_SELECTORS.textCandidates) {
      expect(normalizeText(t)).toBe(t);
    }
  });
});
