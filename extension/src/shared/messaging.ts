/**
 * 类型安全的消息工具：sendMessage 按 MessageMap 约束请求/响应
 */
import { browser } from 'wxt/browser';
import type { MessageMap, MessageResponse } from '@/shared/types/messages';

/**
 * 向 background（或指定 Tab）发送类型化消息
 * @param type 消息类型
 * @param payload 请求体
 * @param tabId 目标 Tab（发给 content script 时必填）
 */
export async function sendMsg<K extends keyof MessageMap>(
  type: K,
  payload: MessageMap[K]['req'],
  tabId?: number,
): Promise<MessageMap[K]['res']> {
  const envelope = { type, payload };
  const raw: unknown = tabId != null
    ? await browser.tabs.sendMessage(tabId, envelope)
    : await browser.runtime.sendMessage(envelope);
  const resp = raw as MessageResponse<MessageMap[K]['res']>;
  if (!resp || typeof resp !== 'object' || !('ok' in resp)) {
    throw new Error(`消息 ${String(type)} 响应格式非法`);
  }
  if (!resp.ok) {
    throw new Error(`${resp.error.code}: ${resp.error.message}`);
  }
  return resp.data;
}

/**
 * 包装异步消息处理器为统一响应格式
 * @param handler 业务处理函数
 */
export function wrapHandler<K extends keyof MessageMap>(
  handler: (payload: MessageMap[K]['req'], sender: unknown) => Promise<MessageMap[K]['res']>,
): (
  payload: MessageMap[K]['req'],
  sender: unknown,
) => Promise<MessageResponse<MessageMap[K]['res']>> {
  return async (payload, sender) => {
    try {
      const data = await handler(payload, sender);
      return { ok: true, data };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return {
        ok: false,
        error: {
          code: err.code ?? 'INTERNAL_ERROR',
          message: err.message ?? String(e),
        },
      };
    }
  };
}
