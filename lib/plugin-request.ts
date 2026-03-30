/**
 * UI iframe 与插件主线程之间的 postMessage 请求封装。
 * 仅应在 UI 中使用（依赖 window / parent）。
 */

import { sendMsgToPlugin, UIMessage, PluginMessage } from '@messages/sender'

/** UI → 插件 */
export type PluginRequestPayload = {
  type: UIMessage
  data?: unknown
}

/** 插件 → UI */
export type PluginMessageEnvelope = {
  type: PluginMessage
  data?: unknown
}

export { UIMessage, PluginMessage }

export function postToPlugin(payload: PluginRequestPayload): void {
  sendMsgToPlugin(payload as { type: UIMessage; data?: any })
}

export function requestFilterableNodes(): void {
  postToPlugin({ type: UIMessage.REQUEST_FILTERABLE_NODES })
}

export function requestSelectNode(nodeId: string): void {
  postToPlugin({ type: UIMessage.SELECT_NODE, data: { nodeId } })
}

const PLUGIN_MESSAGE_VALUES = new Set<string>(Object.values(PluginMessage) as string[])

export function isPluginMessagePayload(msg: unknown): msg is PluginMessageEnvelope {
  if (!msg || typeof msg !== 'object') return false
  const t = (msg as { type?: unknown }).type
  return typeof t === 'string' && PLUGIN_MESSAGE_VALUES.has(t)
}

/**
 * 订阅插件主线程发到 UI 的消息；返回取消订阅函数。
 */
export function subscribePluginMessages(
  handler: (msg: PluginMessageEnvelope, event: MessageEvent) => void
): () => void {
  const fn = (e: MessageEvent) => {
    if (!isPluginMessagePayload(e.data)) return
    handler(e.data, e)
  }
  console.log('=======> subscribePluginMessages <=======')
  window.addEventListener('message', fn)
  return () => window.removeEventListener('message', fn)
}
