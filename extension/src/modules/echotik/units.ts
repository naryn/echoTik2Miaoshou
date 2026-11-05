/**
 * EchoTik 数量/金额字符串解析：处理 "万"/"亿" 单位、货币符号、千分位、空值
 * 示例："59.47万" → 594700；"$82.95万" → 829500(USD)；"5.55亿" → 555000000
 */
import type { ParsedQuantity } from '@/shared/types/domain';

/** 中文数量单位倍率表 */
const UNIT_MULTIPLIERS: Record<string, number> = {
  万: 1e4,
  亿: 1e8,
};

/**
 * 解析带单位/货币符号的数量字符串
 * @param raw 原始字符串（可能为 null/undefined/空串）
 * @returns 解析结果（value 为折算后的数值，raw 保留原文；无法解析时 value 为 null）
 */
export function parseQuantity(raw: string | number | null | undefined): ParsedQuantity {
  // 接口部分字段可能直接返回数字（非字符串），统一转字符串处理
  const text = raw == null ? '' : String(raw).trim();
  if (!text || text === '-' || text === '--') {
    return { value: null, raw: text };
  }
  let currency: ParsedQuantity['currency'];
  let body = text;
  if (body.includes('$')) {
    currency = 'USD';
    body = body.replace('$', '');
  } else if (body.includes('¥') || body.includes('￥')) {
    currency = 'CNY';
    body = body.replace(/[¥￥]/, '');
  }
  body = body.replace(/,/g, '').replace(/%$/, '').trim();

  let multiplier = 1;
  for (const [unit, mult] of Object.entries(UNIT_MULTIPLIERS)) {
    if (body.endsWith(unit)) {
      multiplier = mult;
      body = body.slice(0, -unit.length).trim();
      break;
    }
  }
  const num = Number.parseFloat(body);
  if (Number.isNaN(num)) {
    return { value: null, raw: text, currency };
  }
  // 消除浮点误差（如 3.24 * 1e4 = 32400.000000000004）
  return { value: Number((num * multiplier).toPrecision(12)), raw: text, currency };
}

/**
 * 从榜单条目中提取商品 ID 并保证字符串类型（防 64 位精度丢失）
 * @param raw 原始条目
 */
export function extractProductId(raw: Record<string, unknown>): string | null {
  const id = raw['product_id'];
  if (typeof id === 'string' && id.length > 0) return id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return null;
}
