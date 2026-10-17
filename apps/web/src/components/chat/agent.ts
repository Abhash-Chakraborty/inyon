import { createContext } from 'react'
import type { AgentKind } from '@inyon/protocol'

/** Which agent is speaking in this chat (for avatars, spinners and who "is asking"). */
export const ChatAgent = createContext<AgentKind | undefined>(undefined)
