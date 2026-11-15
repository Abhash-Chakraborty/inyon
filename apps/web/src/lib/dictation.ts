/**
 * Dictation into the message box, with the device's own speech recogniser: the Web Speech API in a
 * browser, Android's SpeechRecognizer in the phone app (its WebView has no Web Speech). Inyon never
 * gets the audio, only the words the recogniser hands back.
 */
import { useEffect, useState } from 'react'
import { platform, plugin } from './native.ts'

/** What has been heard so far: words the recogniser has settled on, then its current guess. */
export interface Spoken {
  final: string
  interim: string
}

export type DictationError = 'not-allowed' | 'no-microphone' | 'no-speech' | 'network' | 'unavailable' | 'busy' | 'other'

/** The box split where the words go in: a selection is replaced, as typing would. */
export interface Anchor {
  before: string
  after: string
}

export const anchorAt = (text: string, start = text.length, end = start): Anchor => {
  const a = Math.max(0, Math.min(start, end, text.length))
  const b = Math.min(text.length, Math.max(start, end))
  return { before: text.slice(0, a), after: text.slice(b) }
}

const tidy = (s: string) => s.replace(/\s+/g, ' ').trim()
const PUNCT = /^[.,!?;:)]/

/** The spoken words as one phrase: the settled ones, then the guess. */
export const phraseOf = (s: Spoken) => tidy(`${s.final} ${s.interim}`)

/**
 * The box with the spoken words in place, and where the cursor goes (after them). A space is added
 * where a word would otherwise run into the text around it, and a phrase that starts the box or a
 * new sentence gets a capital.
 */
export function insertSpoken(at: Anchor, spoken: Spoken | string): { text: string; cursor: number } {
  let phrase = typeof spoken === 'string' ? tidy(spoken) : phraseOf(spoken)
  const { before, after } = at
  if (!phrase) return { text: before + after, cursor: before.length }
  if (!before.trim() || /[.!?]\s*$/.test(before)) phrase = phrase[0]!.toUpperCase() + phrase.slice(1)
  const lead = before && !/\s$/.test(before) && !PUNCT.test(phrase) ? ' ' : ''
  const trail = after && !/^\s/.test(after) && !PUNCT.test(after) ? ' ' : ''
  const head = before + lead + phrase
  return { text: head + trail + after, cursor: head.length }
}

/** A Web Speech result list as settled words and the current guess. */
export function fromResults(results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>): Spoken {
  const final: string[] = []
  const interim: string[] = []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!
    const t = r[0]?.transcript ?? ''
    ;(r.isFinal ? final : interim).push(t)
  }
  return { final: tidy(final.join(' ')), interim: tidy(interim.join(' ')) }
}

/** A Web Speech error name, as one of ours; undefined for one that isn't a failure (aborted). */
export function webError(name: string): DictationError | undefined {
  switch (name) {
    case 'aborted':
      return undefined
    case 'not-allowed':
      return 'not-allowed'
    case 'audio-capture':
      return 'no-microphone'
    case 'service-not-allowed':
    case 'language-not-supported':
    case 'bad-grammar':
      return 'unavailable'
    case 'no-speech':
      return 'no-speech'
    case 'network':
      return 'network'
    default:
      return 'other'
  }
}

export interface Listeners {
  update(s: Spoken): void
  error(e: DictationError): void
  /** always called once, last, however it ended */
  end(): void
}

export interface Recogniser {
  /** finish: what was heard so far is kept */
  stop(): void
  /** drop it: nothing more comes */
  abort(): void
}

/** Starts listening in a language (BCP 47, "en-GB"); throws or reports an error when it can't. */
export type Engine = (lang: string, on: Listeners) => Recogniser

type WebRecognition = {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

/** The browser's recogniser; undefined where there is none, or where it can't reach the microphone (plain http). */
export function webEngine(): Engine | undefined {
  if (typeof window === 'undefined' || !window.isSecureContext) return undefined
  const Ctor = ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition) as (new () => WebRecognition) | undefined
  if (typeof Ctor !== 'function') return undefined
  return (lang, on) => {
    const r = new Ctor()
    r.lang = lang
    r.continuous = true
    r.interimResults = true
    r.maxAlternatives = 1
    r.onresult = (e) => on.update(fromResults(e.results))
    r.onerror = (e) => {
      const err = webError(e.error)
      if (err) on.error(err)
    }
    r.onend = () => on.end()
    r.start()
    return { stop: () => r.stop(), abort: () => r.abort() }
  }
}

type NativeEvent = { id?: string; kind: 'partial' | 'final' | 'error' | 'end'; text?: string; error?: string }

/** The Android app's recogniser (InyonDevice); undefined in a browser or an app without it. */
export function nativeEngine(): Engine | undefined {
  const device = plugin('InyonDevice')
  if (typeof device?.startDictation !== 'function' || typeof device.addListener !== 'function') return undefined
  return (lang, on) => {
    // events carry the run they belong to: the end of the last run mustn't end this one
    const id = Math.random().toString(36).slice(2)
    let done = false
    let handle: Promise<{ remove(): void }> | undefined
    const finish = () => {
      if (done) return
      done = true
      void Promise.resolve(handle).then((h) => h?.remove())
      on.end()
    }
    handle = Promise.resolve(
      device.addListener('dictation', (e: NativeEvent) => {
        if (done || e.id !== id) return
        if (e.kind === 'partial') on.update({ final: '', interim: tidy(e.text ?? '') })
        else if (e.kind === 'final') on.update({ final: tidy(e.text ?? ''), interim: '' })
        else if (e.kind === 'error') on.error(nativeError(e.error))
        else if (e.kind === 'end') finish()
      }) as Promise<{ remove(): void }>,
    )
    // the listener is in place before the recogniser can say anything
    void handle
      .then(() => (done ? undefined : device.startDictation({ id, lang })))
      .catch((e: { code?: string }) => {
        if (done) return
        on.error(nativeError(e?.code))
        finish()
      })
    return {
      stop: () => void Promise.resolve(device.stopDictation?.()).catch(() => {}),
      abort: () => {
        void Promise.resolve(device.cancelDictation?.()).catch(() => {})
        finish()
      },
    }
  }
}

const nativeError = (code: string | undefined): DictationError =>
  code === 'NOT_ALLOWED' ? 'not-allowed' : code === 'NO_SPEECH' ? 'no-speech' : code === 'NETWORK' ? 'network' : code === 'BUSY' ? 'busy' : code === 'UNAVAILABLE' ? 'unavailable' : 'other'

/** The recogniser for this device: the phone app's own on Android, the browser's elsewhere. */
export function dictationEngine(): Engine | undefined {
  // Android's WebView defines webkitSpeechRecognition but it never hears anything
  if (platform() === 'android') return nativeEngine()
  return webEngine()
}

// whether this phone has a speech recogniser at all, once the app has said
let phoneHasRecogniser: boolean | undefined
export const forgetRecogniserCheck = () => void (phoneHasRecogniser = undefined)

/**
 * The recogniser for the message box's microphone, or undefined for no button. In the Android app
 * the phone is asked once whether it has a recogniser; a phone without one has no button.
 */
export function useDictationEngine() {
  const [engine, setEngine] = useState(() => (phoneHasRecogniser === false ? undefined : dictationEngine()))
  useEffect(() => {
    const device = plugin('InyonDevice')
    if (!engine || platform() !== 'android' || phoneHasRecogniser !== undefined || typeof device?.dictationAvailable !== 'function') return
    let live = true
    Promise.resolve(device.dictationAvailable())
      .then((r: { available?: boolean } | undefined) => {
        phoneHasRecogniser = r?.available !== false
        if (live && !phoneHasRecogniser) setEngine(undefined)
      })
      .catch(() => {})
    return () => void (live = false)
  }, [])
  return engine
}

/** The language to listen for: the device's own. */
export const dictationLang = () => (typeof navigator !== 'undefined' && navigator.language) || 'en-US'

/** The toast for a failure; on Android the settings to look in are the phone's. */
export function errorToast(e: DictationError, android = platform() === 'android'): { title: string; body: string; tone: 'warn' | 'error' } {
  switch (e) {
    case 'not-allowed':
      return { title: 'Microphone blocked', body: android ? 'Allow the microphone for Inyon in Android’s settings to dictate.' : 'Allow the microphone for this site in the browser’s settings to dictate.', tone: 'error' }
    case 'no-microphone':
      return { title: 'No microphone', body: 'Connect a microphone to dictate.', tone: 'error' }
    case 'no-speech':
      return { title: 'Didn’t catch that', body: 'Nothing was heard. Tap the microphone and try again.', tone: 'warn' }
    case 'network':
      return { title: 'Dictation needs a connection', body: 'The speech recogniser couldn’t reach its service.', tone: 'error' }
    case 'busy':
      return { title: 'The microphone is busy', body: 'Another app is listening. Try again in a moment.', tone: 'warn' }
    case 'unavailable':
      return { title: 'Dictation isn’t available', body: android ? 'This phone has no speech recogniser for its language.' : 'This browser can’t dictate in its language here.', tone: 'error' }
    default:
      return { title: 'Dictation stopped', body: 'The speech recogniser ran into a problem.', tone: 'error' }
  }
}

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(id: unknown): void
}
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) }

export interface DictationOptions {
  engine: Engine
  lang: string
  /** the box when it started, and the selection the words replace */
  text: string
  start?: number
  end?: number
  /** the box as it should read now; `done` once listening has ended */
  onText(text: string, cursor: number, done: boolean): void
  onError(e: DictationError): void
  onEnd(): void
  /** stop this long after the last words (the browser's recogniser would keep going) */
  silenceMs?: number
  /** and this long after starting when nothing at all is heard */
  quietMs?: number
  timers?: Timers
}

export const SILENCE_MS = 2500
export const QUIET_MS = 8000

/**
 * One dictation, from the tap on the microphone to the end. The words go in where the cursor was,
 * the guess shown live and replaced as the recogniser settles. It stops on a second tap, or by
 * itself once you've been quiet for a moment.
 */
export class Dictation {
  private readonly at: Anchor
  private spoken: Spoken = { final: '', interim: '' }
  private rec: Recogniser | undefined
  private timer: unknown
  private ended = false
  private heard = false
  private failed = false
  private stopped = false
  private readonly timers: Timers
  constructor(private readonly o: DictationOptions) {
    this.at = anchorAt(o.text, o.start, o.end)
    this.timers = o.timers ?? realTimers
  }

  start() {
    this.arm(this.o.quietMs ?? QUIET_MS)
    try {
      this.rec = this.o.engine(this.o.lang, {
        update: (s) => this.update(s),
        error: (e) => this.fail(e),
        end: () => this.finish(),
      })
    } catch {
      this.fail('unavailable')
      this.finish()
    }
    return this
  }

  get listening() {
    return !this.ended
  }

  /** what the box reads with what has been heard so far */
  current() {
    return insertSpoken(this.at, this.spoken)
  }

  /** a tap on the microphone: what was heard stays */
  stop() {
    if (this.ended) return
    this.stopped = true
    this.ask()
  }

  /**
   * Stop without waiting for the recogniser, and leave the box as it is: you typed over the words,
   * sent the message or left the chat. Nothing more is written.
   */
  abort() {
    if (this.ended) return
    this.stopped = true
    this.rec?.abort()
    this.finish(false)
  }

  private update(s: Spoken) {
    if (this.ended) return
    this.spoken = s
    if (phraseOf(s)) this.heard = true
    this.arm(this.heard ? (this.o.silenceMs ?? SILENCE_MS) : (this.o.quietMs ?? QUIET_MS))
    const { text, cursor } = this.current()
    this.o.onText(text, cursor, false)
  }

  private fail(e: DictationError) {
    if (this.ended || this.failed) return
    // the browser's recogniser says no-speech after a pause even when it heard you before it
    if (e === 'no-speech' && this.heard) return
    this.failed = true
    this.o.onError(e)
  }

  private finish(write = true) {
    if (this.ended) return
    this.ended = true
    this.timers.clear(this.timer)
    // a guess the recogniser never settled stays: it's what you saw in the box
    if (write && this.heard) {
      const { text, cursor } = this.current()
      this.o.onText(text, cursor, true)
    } else if (write && !this.failed && !this.stopped && this.rec) {
      // it gave up on its own with nothing heard; tapped off before speaking says nothing
      this.failed = true
      this.o.onError('no-speech')
    }
    this.o.onEnd()
  }

  private arm(ms: number) {
    this.timers.clear(this.timer)
    this.timer = this.timers.set(() => this.ask(), ms)
  }

  /** asks the recogniser to finish; one that doesn't end soon after is let go */
  private ask() {
    this.timers.clear(this.timer)
    this.timer = this.timers.set(() => {
      this.rec?.abort()
      this.finish()
    }, 1500)
    this.rec?.stop()
  }
}
