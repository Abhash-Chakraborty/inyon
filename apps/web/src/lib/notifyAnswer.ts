import { api } from './api.ts'
import { clearNativeNotification, nativeNotify, type NotificationAnswer } from './native.ts'
import { findPane, useStore } from './store.ts'

/**
 * Sends an answer tapped on a notification. Only while the session still asks that question with
 * that answer at that number: a tap that comes late never lands on the next question. The
 * notification goes once the agent has it, or says why it didn't.
 */
export async function answerFromNotification(a: NotificationAnswer) {
  const href = `/m/${encodeURIComponent(a.host)}/p/${a.pane.replace(/^%/, '')}`
  const agent = findPane(useStore.getState().hosts, a.host, a.pane)?.agent
  if (agent?.state !== 'waiting' || !agent.options?.some((o) => o.n === a.option && o.label === a.label)) {
    await nativeNotify('That question changed', `“${a.label}” wasn't sent. Open the session to see what it asks now.`, href, a.tag, 'done')
    return
  }
  try {
    await api.answer(a.host, a.pane, a.option)
    clearNativeNotification(a.tag)
  } catch (e) {
    await nativeNotify("Couldn't send your answer", (e as Error).message, href, a.tag, 'waiting')
  }
}
