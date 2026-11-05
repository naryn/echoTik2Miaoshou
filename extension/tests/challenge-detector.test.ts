/**
 * 验证/访问限制检测器规则单测（规范 §5.5）
 */
import { describe, expect, it } from 'vitest';
import { detectChallenge, isRecovered, type ChallengeSignals } from '../src/modules/challenge/detector';

const base: ChallengeSignals = {
  url: 'https://www.tiktok.com/shop/pdp/1732052189676081387',
  productEvidenceFound: true,
  miaoshouAvailable: true,
  bodyTextSample: '商品标题 价格 $93 加入购物车',
};

describe('detectChallenge', () => {
  it('正常商品页判定为 CLEAR', () => {
    const v = detectChallenge(base);
    expect(v.state).toBe('CLEAR');
    expect(v.matchedRules).toHaveLength(0);
  });

  it('challenge 路由 URL 判定为 CHALLENGE', () => {
    const v = detectChallenge({ ...base, url: 'https://www.tiktok.com/challenge/verify?next=xxx' });
    expect(v.state).toBe('CHALLENGE');
    expect(v.matchedRules).toContain('url-challenge-route');
  });

  it('captcha iframe 判定为 CHALLENGE', () => {
    const v = detectChallenge({ ...base, hasChallengeIframe: true });
    expect(v.state).toBe('CHALLENGE');
    expect(v.matchedRules).toContain('iframe-challenge');
  });

  it('captcha DOM 判定为 CHALLENGE', () => {
    const v = detectChallenge({ ...base, hasCaptchaDom: true });
    expect(v.state).toBe('CHALLENGE');
    expect(v.matchedRules).toContain('dom-captcha');
  });

  it('人机验证文案判定为 CHALLENGE', () => {
    const v = detectChallenge({ ...base, bodyTextSample: 'Please verify you are human to continue' });
    expect(v.state).toBe('CHALLENGE');
  });

  it('访问限制文案判定为 ACCESS_RESTRICTED', () => {
    const v = detectChallenge({ ...base, bodyTextSample: '访问过于频繁，请稍后再试' });
    expect(v.state).toBe('ACCESS_RESTRICTED');
    expect(v.matchedRules).toContain('text-access-restricted');
  });

  it('组合信号：商品证据缺失 + 安全验证文案 → CHALLENGE', () => {
    const v = detectChallenge({
      ...base,
      productEvidenceFound: false,
      bodyTextSample: '页面加载中… 安全验证',
    });
    expect(v.state).toBe('CHALLENGE');
    expect(v.matchedRules).toContain('combo-missing-product-with-security-text');
  });

  it('商品加载慢（证据缺失但无安全文案）不误判', () => {
    const v = detectChallenge({ ...base, productEvidenceFound: false, bodyTextSample: '' });
    expect(v.state).toBe('CLEAR');
  });
});

describe('isRecovered', () => {
  it('验证消失 + 商品恢复 + 妙手可用 → 恢复', () => {
    expect(isRecovered(base)).toBe(true);
  });

  it('妙手按钮不可用 → 未恢复', () => {
    expect(isRecovered({ ...base, miaoshouAvailable: false })).toBe(false);
  });

  it('仍在 challenge → 未恢复', () => {
    expect(isRecovered({ ...base, hasChallengeIframe: true })).toBe(false);
  });
});
