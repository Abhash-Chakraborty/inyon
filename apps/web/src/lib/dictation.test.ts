import { afterEach, describe, expect, mock, test } from 'bun:test'
import { anchorAt, Dictation, dictationEngine, errorToast, fromResults, insertSpoken, nativeEngine, webEngine, webError, type DictationError, type Engine, type Listeners, type Timers } from './dictation.ts'

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('the words go in where the cursor was', () => {
  test('at the end of a sentence, after a space', () => {
    expect(insertSpoken(anchorAt('Fix the'), 'login bug')).toEqual({ text: 'Fix the login bug', cursor: 17 })
    expect(insertSpoken(anchorAt('Fix the '), 'login bug').text).toBe('Fix the login bug')
  })

  test('in the middle, with a space on each side', () => {
    const text = 'Fix bug'
    expect(insertSpoken(anchorAt(text, 3), 'the login')).toEqual({ text: 'Fix the login bug', cursor: 13 })
  })

  test('over a selection, as typing would', () => {
    const text = 'Fix the signup bug'
    expect(insertSpoken(anchorAt(text, 8, 14), 'login').text).toBe('Fix the login bug')
    // a selection made backwards is the same selection
    expect(insertSpoken(anchorAt(text, 14, 8), 'login').text).toBe('Fix the login bug')
  })

  test('a capital at the start of the box and of a sentence, not in the middle of one', () => {
    expect(insertSpoken(anchorAt(''), 'run the tests').text).toBe('Run the tests')
    expect(insertSpoken(anchorAt('Done.'), 'now push it').text).toBe('Done. Now push it')
    expect(insertSpoken(anchorAt('Run'), 'the tests').text).toBe('Run the tests')
  })

  test('punctuation joins the word before it', () => {
    expect(insertSpoken(anchorAt('Fix it'), ', please').text).toBe('Fix it, please')
    expect(insertSpoken(anchorAt('Fix it.', 6), 'now').text).toBe('Fix it now.')
  })

  test('nothing heard leaves the box as it was', () => {
    expect(insertSpoken(anchorAt('Fix the bug', 4), { final: '', interim: '  ' })).toEqual({ text: 'Fix the bug', cursor: 4 })
  })

  test('the settled words come first, then the guess', () => {
    expect(insertSpoken(anchorAt(''), { final: 'fix the', interim: 'log in' }).text).toBe('Fix the log in')
  })
})

describe('Web Speech results', () => {
  const r = (transcript: string, isFinal: boolean) => Object.assign([{ transcript }], { isFinal })

  test('settled segments and the open guess, with the spaces tidied', () => {
    expect(fromResults([r('fix the', true), r(' login bug', true), r(' in the', false)])).toEqual({ final: 'fix the login bug', interim: 'in the' })
  })

  test('aborted is not a failure; the rest are named', () => {
    expect(webError('aborted')).toBeUndefined()
    expect(webError('not-allowed')).toBe('not-allowed')
    expect(webError('service-not-allowed')).toBe('unavailable')
    expect(webError('audio-capture')).toBe('no-microphone')
    expect(webError('no-speech')).toBe('no-speech')
    expect(webError('network')).toBe('network')
    expect(webError('something-new')).toBe('other')
  })

  test('the toasts say what to do', () => {
    expect(errorToast('not-allowed', false)).toMatchObject({ title: 'Microphone blocked', tone: 'error' })
    expect(errorToast('not-allowed', true).body).toContain('Android')
    expect(errorToast('no-speech', false)).toMatchObject({ title: 'Didn’t catch that', tone: 'warn' })
  })
})

/** A recogniser the test speaks through. */
function fakeEngine() {
  const calls = { stop: 0, abort: 0, lang: '' }
  let on: Listeners | undefined
  const engine: Engine = (lang, l) => {
    calls.lang = lang
    on = l
    return { stop: () => void calls.stop++, abort: () => void calls.abort++ }
  }
  return { engine, calls, say: (final: string, interim = '') => on!.update({ final, interim }), error: (e: DictationError) => on!.error(e), end: () => on!.end() }
}

/** Timers the test runs by hand. */
function fakeTimers() {
  let next = 0
  const due = new Map<number, { fn: () => void; ms: number }>()
  const timers: Timers = {
    set: (fn, ms) => (due.set(++next, { fn, ms }), next),
    clear: (id) => void due.delete(id as number),
  }
  /** runs the one pending timer, checking how long it was set for */
  const fire = (ms?: number) => {
    expect(due.size).toBe(1)
    const [id, t] = [...due][0]!
    if (ms !== undefined) expect(t.ms).toBe(ms)
    due.delete(id)
    t.fn()
  }
  return { timers, fire, pending: () => due.size }
}

function start(text = '', at?: number) {
  const fake = fakeEngine()
  const clock = fakeTimers()
  const seen: { text: string; cursor: number; done: boolean }[] = []
  const errors: DictationError[] = []
  const ended = mock(() => {})
  const d = new Dictation({
    engine: fake.engine,
    lang: 'en-GB',
    text,
    start: at,
    end: at,
    onText: (t, cursor, done) => seen.push({ text: t, cursor, done }),
    onError: (e) => errors.push(e),
    onEnd: ended,
    silenceMs: 2500,
    quietMs: 8000,
    timers: clock.timers,
  }).start()
  return { d, ...fake, ...clock, seen, errors, ended, last: () => seen.at(-1) }
}

describe('a dictation', () => {
  test('listens in the language it was given', () => {
    expect(start().calls.lang).toBe('en-GB')
  })

  test('shows the guess live and replaces it as it settles', () => {
    const s = start('Fix ', 4)
    s.say('', 'the')
    expect(s.last()).toEqual({ text: 'Fix the', cursor: 7, done: false })
    s.say('', 'the log in')
    expect(s.last()!.text).toBe('Fix the log in')
    s.say('the login', '')
    expect(s.last()!.text).toBe('Fix the login')
    s.say('the login', 'bug')
    expect(s.last()!.text).toBe('Fix the login bug')
    s.say('the login bug')
    s.end()
    expect(s.last()).toEqual({ text: 'Fix the login bug', cursor: 17, done: true })
    expect(s.ended).toHaveBeenCalledTimes(1)
    expect(s.d.listening).toBe(false)
    expect(s.errors).toEqual([])
  })

  test('keeps the text after the cursor where it was', () => {
    const s = start('Fix bug', 3)
    s.say('the login')
    s.end()
    expect(s.last()).toEqual({ text: 'Fix the login bug', cursor: 13, done: true })
  })

  test('a tap stops it and keeps what was heard, an unsettled guess too', () => {
    const s = start()
    s.say('run the', 'tests')
    s.d.stop()
    expect(s.calls.stop).toBe(1)
    expect(s.d.listening).toBe(true)
    s.end()
    expect(s.last()).toEqual({ text: 'Run the tests', cursor: 13, done: true })
    expect(s.errors).toEqual([])
  })

  test('stops by itself after a pause in speech', () => {
    const s = start()
    s.say('', 'run')
    s.say('run the tests')
    s.fire(2500)
    expect(s.calls.stop).toBe(1)
    s.end()
    expect(s.last()!.text).toBe('Run the tests')
  })

  test("says it didn't catch anything when nothing was heard", () => {
    const s = start()
    s.fire(8000)
    expect(s.calls.stop).toBe(1)
    s.end()
    expect(s.errors).toEqual(['no-speech'])
    expect(s.seen).toEqual([])
  })

  test('a recogniser that never ends after a stop is let go', () => {
    const s = start()
    s.say('hello')
    s.d.stop()
    s.fire(1500)
    expect(s.calls.abort).toBe(1)
    expect(s.d.listening).toBe(false)
    expect(s.ended).toHaveBeenCalledTimes(1)
    expect(s.last()).toEqual({ text: 'Hello', cursor: 5, done: true })
  })

  test('tapped off before speaking: no toast', () => {
    const s = start()
    s.d.stop()
    s.end()
    expect(s.errors).toEqual([])
  })

  test('the browser saying no-speech after a pause in speech is not an error', () => {
    const s = start()
    s.say('hello')
    s.error('no-speech')
    s.end()
    expect(s.errors).toEqual([])
    expect(s.last()!.text).toBe('Hello')
  })

  test('a blocked microphone is said once', () => {
    const s = start()
    s.error('not-allowed')
    s.end()
    expect(s.errors).toEqual(['not-allowed'])
    expect(s.ended).toHaveBeenCalledTimes(1)
  })

  test('aborting writes nothing more, and later results are ignored', () => {
    const s = start('Draft')
    s.say('', 'one')
    const before = s.seen.length
    s.d.abort()
    expect(s.calls.abort).toBe(1)
    expect(s.ended).toHaveBeenCalledTimes(1)
    s.say('one two')
    s.end()
    expect(s.seen.length).toBe(before)
    expect(s.ended).toHaveBeenCalledTimes(1)
    expect(s.errors).toEqual([])
    expect(s.pending()).toBe(0)
  })

  test("a recogniser that can't start ends at once with a reason", () => {
    const errors: DictationError[] = []
    const ended = mock(() => {})
    const d = new Dictation({
      engine: () => {
        throw new Error('InvalidStateError')
      },
      lang: 'en',
      text: '',
      onText: () => {},
      onError: (e) => errors.push(e),
      onEnd: ended,
      timers: fakeTimers().timers,
    }).start()
    expect(d.listening).toBe(false)
    expect(errors).toEqual(['unavailable'])
    expect(ended).toHaveBeenCalledTimes(1)
  })
})

describe('which recogniser', () => {
  const secure = Object.getOwnPropertyDescriptor(window, 'isSecureContext')
  afterEach(() => {
    delete (window as any).webkitSpeechRecognition
    delete (window as any).SpeechRecognition
    delete (window as any).Capacitor
    if (secure) Object.defineProperty(window, 'isSecureContext', secure)
    else delete (window as any).isSecureContext
  })
  const setSecure = (v: boolean) => Object.defineProperty(window, 'isSecureContext', { value: v, configurable: true })

  class FakeRecognition {
    static last: FakeRecognition
    lang = ''
    continuous = false
    interimResults = false
    maxAlternatives = 0
    onresult: any = null
    onerror: any = null
    onend: any = null
    started = 0
    constructor() {
      FakeRecognition.last = this
    }
    start() {
      this.started++
    }
    stop() {}
    abort() {}
  }

  test('none in a browser without Web Speech, or over plain http', () => {
    setSecure(true)
    expect(webEngine()).toBeUndefined()
    ;(window as any).webkitSpeechRecognition = FakeRecognition
    setSecure(false)
    expect(webEngine()).toBeUndefined()
  })

  test("the browser's, listening continuously with live guesses", () => {
    setSecure(true)
    ;(window as any).webkitSpeechRecognition = FakeRecognition
    const update = mock((_s: unknown) => {})
    const error = mock((_e: unknown) => {})
    const end = mock(() => {})
    dictationEngine()!('fr-FR', { update, error, end })
    const r = FakeRecognition.last
    expect([r.lang, r.continuous, r.interimResults, r.started]).toEqual(['fr-FR', true, true, 1])
    r.onresult({ results: [Object.assign([{ transcript: 'bonjour' }], { isFinal: false })] })
    expect(update).toHaveBeenCalledWith({ final: '', interim: 'bonjour' })
    r.onerror({ error: 'aborted' })
    expect(error).not.toHaveBeenCalled()
    r.onerror({ error: 'not-allowed' })
    expect(error).toHaveBeenCalledWith('not-allowed')
    r.onend()
    expect(end).toHaveBeenCalledTimes(1)
  })

  /** The Android app, with InyonDevice's dictation methods (or an older app without them). */
  function android(device: Record<string, any>) {
    const listeners: Record<string, ((e: any) => void)[]> = {}
    const removed = mock(() => {})
    device.addListener = (event: string, fn: (e: any) => void) => {
      ;(listeners[event] ||= []).push(fn)
      return Promise.resolve({ remove: removed })
    }
    ;(window as any).Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { InyonDevice: device } }
    // events go to the run that was last started, as the app sends them
    const run = () => (device.startDictation as ReturnType<typeof mock>).mock.calls.at(-1)?.[0]?.id
    return { emit: (e: object) => listeners.dictation?.forEach((f) => f({ id: run(), ...e })), removed, listeners }
  }

  test("in the Android app, the phone's own, never the WebView's Web Speech", () => {
    setSecure(true)
    ;(window as any).webkitSpeechRecognition = FakeRecognition
    android({})
    expect(dictationEngine()).toBeUndefined()
    android({ startDictation: async () => ({ ok: true }) })
    expect(dictationEngine()).toBeDefined()
  })

  test("the phone's partial and final results, then the end", async () => {
    const startDictation = mock(async (_o: unknown) => ({ ok: true }))
    const stopDictation = mock(async () => ({ ok: true }))
    const { emit, removed } = android({ startDictation, stopDictation })
    const update = mock((_s: unknown) => {})
    const error = mock((_e: unknown) => {})
    const end = mock(() => {})
    const rec = nativeEngine()!('de-DE', { update, error, end })
    await flush()
    expect(startDictation).toHaveBeenCalledWith({ id: expect.any(String), lang: 'de-DE' })
    emit({ kind: 'partial', text: 'hallo' })
    emit({ kind: 'final', text: 'hallo welt' })
    expect(update.mock.calls).toEqual([[{ final: '', interim: 'hallo' }], [{ final: 'hallo welt', interim: '' }]])
    rec.stop()
    expect(stopDictation).toHaveBeenCalledTimes(1)
    emit({ kind: 'end' })
    expect(end).toHaveBeenCalledTimes(1)
    await flush()
    expect(removed).toHaveBeenCalledTimes(1)
    // nothing after the end reaches the box
    emit({ kind: 'final', text: 'late' })
    expect(update).toHaveBeenCalledTimes(2)
  })

  test('a refused microphone permission on the phone', async () => {
    const { emit } = android({ startDictation: mock(async () => Promise.reject(Object.assign(new Error('Microphone blocked'), { code: 'NOT_ALLOWED' }))) })
    const error = mock((_e: unknown) => {})
    const end = mock(() => {})
    nativeEngine()!('en-US', { update: () => {}, error, end })
    await flush()
    await flush()
    expect(error).toHaveBeenCalledWith('not-allowed')
    expect(end).toHaveBeenCalledTimes(1)
    emit({ kind: 'end' })
    expect(end).toHaveBeenCalledTimes(1)
  })

  test("the phone's errors by code", async () => {
    const { emit } = android({ startDictation: mock(async () => ({ ok: true })) })
    const error = mock((_e: unknown) => {})
    nativeEngine()!('en-US', { update: () => {}, error, end: () => {} })
    await flush()
    emit({ kind: 'error', error: 'NO_SPEECH' })
    emit({ kind: 'error', error: 'NETWORK' })
    emit({ kind: 'error', error: 'BUSY' })
    expect(error.mock.calls).toEqual([['no-speech'], ['network'], ['busy']])
  })
})

test("the end of the phone's last run doesn't end the next one", async () => {
  const listeners: ((e: any) => void)[] = []
  const startDictation = mock(async (_o: { id: string }) => ({ ok: true }))
  ;(window as any).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: { InyonDevice: { startDictation, addListener: (_: string, fn: (e: any) => void) => (listeners.push(fn), Promise.resolve({ remove() {} })) } },
  }
  try {
    const end = mock(() => {})
    const update = mock((_s: unknown) => {})
    nativeEngine()!('en-US', { update, error: () => {}, end })
    await flush()
    const id = startDictation.mock.calls[0]![0].id
    listeners.forEach((f) => f({ id: 'an-older-run', kind: 'end' }))
    listeners.forEach((f) => f({ id: 'an-older-run', kind: 'final', text: 'old words' }))
    expect(end).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    listeners.forEach((f) => f({ id, kind: 'end' }))
    expect(end).toHaveBeenCalledTimes(1)
  } finally {
    delete (window as any).Capacitor
  }
})
