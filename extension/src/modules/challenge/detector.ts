/**
 * TikTok 验证/访问限制检测器（规范 §5.5）
 * - 规则表可配置、可测试，不只匹配"验证码"三个字
 * - 组合信号：challenge iframe / 路由到 challenge 页 / 访问限制文案 / 商品证据缺失+安全提示
 * - 恢复判据：验证消失 + 商品内容恢复 + 妙手按钮可用
 * 本模块为纯逻辑（输入信号事实，输出判定），便于单测。
 */

/** 页面信号事实（由 content script 采集） */
export interface ChallengeSignals {
  /** 当前页面 URL */
  url: string;
  /** 页面标题（可选） */
  title?: string;
  /** 是否发现 challenge/captcha iframe */
  hasChallengeIframe?: boolean;
  /** 是否发现 captcha 相关 DOM（容器/脚本） */
  hasCaptchaDom?: boolean;
  /** 正文文本小样本（截断后，脱敏） */
  bodyTextSample?: string;
  /** 是否找到目标商品证据（标题/价格/商品 ID 匹配） */
  productEvidenceFound?: boolean;
  /** 妙手按钮是否可用 */
  miaoshouAvailable?: boolean;
}

/** 判定结果 */
export interface ChallengeVerdict {
  state: 'CLEAR' | 'CHALLENGE' | 'ACCESS_RESTRICTED';
  matchedRules: string[];
}

/** 规则定义 */
export interface ChallengeRule {
  id: string;
  kind: 'url' | 'iframe' | 'dom' | 'text' | 'combo';
  /** kind 为 url/text 时的正则来源 */
  pattern?: string;
  /** 命中的判定级别 */
  verdict: 'CHALLENGE' | 'ACCESS_RESTRICTED';
  description: string;
}

/** 默认规则表（可更新、可测试） */
export const DEFAULT_CHALLENGE_RULES: ChallengeRule[] = [
  {
    id: 'url-challenge-route',
    kind: 'url',
    pattern: '/challenge|[?&]challenge=|sec-sdk|captcha',
    verdict: 'CHALLENGE',
    description: 'URL 跳转到 challenge/验证路由',
  },
  {
    id: 'iframe-challenge',
    kind: 'iframe',
    verdict: 'CHALLENGE',
    description: '页面存在 challenge/captcha iframe（如 arkose/sec-sdk）',
  },
  {
    id: 'dom-captcha',
    kind: 'dom',
    verdict: 'CHALLENGE',
    description: '页面存在 captcha 容器 DOM',
  },
  {
    id: 'text-verify-human',
    kind: 'text',
    pattern: 'verify (you are|to continue)|human verification|complete the security check|安全验证|人机验证|拖动滑块|完成验证',
    verdict: 'CHALLENGE',
    description: '出现人机验证文案',
  },
  {
    id: 'text-access-restricted',
    kind: 'text',
    pattern: 'access denied|too many requests|rate limit|访问受限|访问过于频繁|操作过于频繁|稍后再试',
    verdict: 'ACCESS_RESTRICTED',
    description: '出现访问限制文案',
  },
];

/**
 * 按规则表判定页面是否处于验证/访问限制状态
 * @param signals 页面信号事实
 * @param rules 规则表（默认 DEFAULT_CHALLENGE_RULES）
 */
export function detectChallenge(
  signals: ChallengeSignals,
  rules: ChallengeRule[] = DEFAULT_CHALLENGE_RULES,
): ChallengeVerdict {
  const matched: string[] = [];
  let verdict: ChallengeVerdict['state'] = 'CLEAR';
  const urlLower = signals.url.toLowerCase();
  const textLower = (signals.bodyTextSample ?? '').toLowerCase();

  for (const rule of rules) {
    let hit = false;
    switch (rule.kind) {
      case 'url':
        hit = !!rule.pattern && new RegExp(rule.pattern, 'i').test(urlLower);
        break;
      case 'iframe':
        hit = signals.hasChallengeIframe === true;
        break;
      case 'dom':
        hit = signals.hasCaptchaDom === true;
        break;
      case 'text':
        hit = !!rule.pattern && new RegExp(rule.pattern, 'i').test(textLower);
        break;
      case 'combo':
        hit = false;
        break;
    }
    if (hit) {
      matched.push(rule.id);
      if (rule.verdict === 'ACCESS_RESTRICTED') verdict = 'ACCESS_RESTRICTED';
      else if (verdict === 'CLEAR') verdict = 'CHALLENGE';
    }
  }

  // 组合规则：商品证据缺失 + 安全验证文案出现 → CHALLENGE（防止误判普通加载慢页面）
  if (
    signals.productEvidenceFound === false &&
    /安全验证|人机验证|verify|security check/i.test(textLower)
  ) {
    matched.push('combo-missing-product-with-security-text');
    if (verdict === 'CLEAR') verdict = 'CHALLENGE';
  }

  return { state: verdict, matchedRules: matched };
}

/**
 * 恢复判据（规范 §5.5）：验证消失 + 商品内容恢复 + 妙手按钮可用
 * @param signals 页面信号事实
 */
export function isRecovered(signals: ChallengeSignals): boolean {
  const verdict = detectChallenge(signals);
  return (
    verdict.state === 'CLEAR' &&
    signals.productEvidenceFound === true &&
    signals.miaoshouAvailable === true
  );
}
