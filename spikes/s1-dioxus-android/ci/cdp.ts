// Talks to the app's WebView over the DevTools protocol (adb forward to webview_devtools_remote_<pid>).
//   bun cdp.ts <port> eval '<expression>'     prints the JSON value (promises are awaited)
//   bun cdp.ts <port> tap '<css selector>'    a real touch at the element's centre
const [port, cmd, arg] = process.argv.slice(2)
const pages = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[]
const page = pages.find((p) => p.type === 'page') ?? pages[0]
if (!page) throw new Error('no page to attach to')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let next = 0
const waiting = new Map<number, (v: any) => void>()
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data))
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)!(m); waiting.delete(m.id) }
}
const send = (method: string, params: object = {}) =>
  new Promise<any>((r) => { const id = ++next; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async (expression: string) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
  return r.result?.result?.value
}

if (cmd === 'eval') {
  console.log(JSON.stringify(await evaluate(arg)))
} else if (cmd === 'tap') {
  const rect = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(arg)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`)
  const [x, y] = rect as [number, number]
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  console.log(JSON.stringify({ tapped: arg, x, y }))
} else {
  throw new Error(`unknown command ${cmd}`)
}
ws.close()
process.exit(0)
