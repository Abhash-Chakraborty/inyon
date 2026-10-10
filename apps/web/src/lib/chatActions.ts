import { createContext } from 'react'
import type { BackgroundTask } from '@tether/protocol'

/** Actions chat rows can trigger in the surrounding session view. */
export interface ChatActions {
  openSubagent(toolUseId: string): void
  openTask(task: BackgroundTask): void
}

export const ChatActionsContext = createContext<ChatActions>({ openSubagent() {}, openTask() {} })
