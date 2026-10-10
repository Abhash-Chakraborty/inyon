import { mock } from 'bun:test'
import type { ServerMsg } from '@tether/protocol'
import * as realModule from '../lib/api.ts'

/**
 * Stand-ins for the network: `api` and `socket` replace the real ones in every test (see
 * setup.ts). `realApi` keeps the real request code for api.test.ts, which fakes `fetch` instead.
 */
export const realApi = { ...realModule.api }
export const realApiModule = { ...realModule }

type Api = typeof realModule.api
type Fake<T> = { [K in keyof T]: T[K] extends (...a: infer A) => infer R ? ReturnType<typeof mock<(...a: A) => R>> : T[K] }

const fakeApi = {} as Fake<Api>
/** Every call resolves to `{}` unless a test says otherwise. */
export function resetApi() {
  for (const k of Object.keys(realApi) as (keyof Api)[]) (fakeApi as any)[k] = mock(async () => ({}))
}
resetApi()
export const api = fakeApi

const listeners = new Set<(m: ServerMsg) => void>()
export const socket = {
  up: false,
  start() {},
  stop() {},
  send: mock((_msg: unknown) => {}),
  on(fn: (m: ServerMsg) => void) {
    listeners.add(fn)
    return () => void listeners.delete(fn)
  },
  onChatClosed: () => () => {},
  onStatus: () => () => {},
  watching: () => false,
  subscribeOverview() {},
  subscribeChat: mock((_host: string, _pane: string) => () => {}),
}

/** Delivers a message from the hub, as the socket would. */
export const emit = (m: ServerMsg) => listeners.forEach((l) => l(m))
