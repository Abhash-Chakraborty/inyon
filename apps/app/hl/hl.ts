// Code highlighting for the app at /next, with the web app's highlight.js setup
// (components/chat/highlight.ts): the same languages, each fetched the first time a block in it
// shows. hl/build.ts bundles it, build.sh names it in index.html, and the app loads it the first
// time a reply has a code block, then drives it from Rust (src/highlight.rs) through
// `window.inyonHighlight`.

import { highlight, isLoaded, languageOf, loadLanguage } from '../../web/src/components/chat/highlight.ts'

/** The language highlight.js knows a fence's name by (`ts` is typescript), or undefined. */
const known = (name: string) => languageOf(`language-${name}`)

;(window as any).inyonHighlight = {
  /** Highlighted markup for `code` when its language is already here, otherwise undefined. */
  now(name: string, code: string): string | undefined {
    const lang = known(name)
    return lang && isLoaded(lang) ? highlight(lang, code) : undefined
  },
  /** Fetches the language; true once it's here, false for one we don't ship or a failed fetch. */
  load(name: string): Promise<boolean> {
    const lang = known(name)
    return lang ? loadLanguage(lang) : Promise.resolve(false)
  },
}
