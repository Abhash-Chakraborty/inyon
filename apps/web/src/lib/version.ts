import { VERSION } from '@tether/protocol'

declare const __TETHER_COMMIT__: string

/** The commit this build came from (set by Vite; empty in tests and unbuilt runs). */
export const COMMIT = typeof __TETHER_COMMIT__ === 'string' ? __TETHER_COMMIT__ : ''

export { VERSION }
