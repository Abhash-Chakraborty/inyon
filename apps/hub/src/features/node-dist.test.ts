import { afterAll, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { nodeRoutes, releaseFile, targetOf, updateScript } from './node-dist.ts'

const url = (q: string) => new URL(`http://hub/node/inyon?${q}`)
const get = (route: keyof typeof nodeRoutes) => nodeRoutes[route](new Request(`http://hub${route}`))

test('a download names its system; Windows on ARM gets the x64 build', () => {
  expect(targetOf(url('os=linux&arch=arm64'))).toBe('linux-arm64')
  expect(targetOf(url('os=darwin&arch=x64'))).toBe('darwin-x64')
  expect(targetOf(url('os=windows&arch=arm64'))).toBe('windows-x64')
  // what tether-node's Windows installer asked with: no os at all
  expect(targetOf(url('arch=x64'))).toBe('windows-x64')
  expect(() => targetOf(url('os=plan9&arch=x64'))).toThrow('os must be')
  expect(() => targetOf(url('os=linux&arch=x86'))).toThrow('arch must be')
})

test('tether-node as a Bun script is told to run "Add a machine" again', async () => {
  const res = await get('/node/tether-node.ts')
  expect(res.status).toBe(410)
  expect(await res.text()).toContain('Copy the "Add a machine" command from the hub again')
  await expect(updateScript('linux', 'x64')).rejects.toThrow('Add a machine')
})

test('the installers are served as they are in the repository', async () => {
  expect(await (await get('/node/install.sh')).text()).toStartWith('#!/bin/sh\n')
  expect(await (await get('/node/install.ps1')).text()).toContain("$TaskName = 'Inyon node'")
})

// A stand-in for the GitHub release the hub takes the program from.
const sha = (b: string | Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')
const BUILD = 'the linux build'
const GZ = zlib.gzipSync(BUILD)
let requests: string[] = []
const release = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const name = new URL(req.url).pathname.slice(1)
    requests.push(name)
    if (name === 'inyon-linux-x64') return new Response(BUILD)
    if (name === 'inyon-linux-x64.gz') return new Response(GZ)
    return new Response('no', { status: 404 })
  },
})
afterAll(() => release.stop(true))
const base = () => `http://127.0.0.1:${release.port}`

test('the hub takes the gzipped release file when SHA256SUMS lists one, and keeps the plain bytes', async () => {
  const sums = `${sha(BUILD)}  inyon-linux-x64\n${sha(GZ)}  inyon-linux-x64.gz\n`
  expect((await releaseFile('inyon-linux-x64', sums, base())).toString()).toBe(BUILD)
  expect(requests).toEqual(['inyon-linux-x64.gz'])

  // a release from before 0.11: the plain file
  requests = []
  expect((await releaseFile('inyon-linux-x64', `${sha(BUILD)}  inyon-linux-x64\n`, base())).toString()).toBe(BUILD)
  expect(requests).toEqual(['inyon-linux-x64'])
})

test('both the .gz and what it unpacks to are checked, and a file not listed is refused', async () => {
  await expect(releaseFile('inyon-linux-x64', `${sha(BUILD)}  inyon-linux-x64\n${sha('other')}  inyon-linux-x64.gz\n`, base())).rejects.toThrow('inyon-linux-x64.gz did not match')
  await expect(releaseFile('inyon-linux-x64', `${sha('other')}  inyon-linux-x64\n${sha(GZ)}  inyon-linux-x64.gz\n`, base())).rejects.toThrow('inyon-linux-x64 did not match')
  await expect(releaseFile('inyon-darwin-x64', `${sha(BUILD)}  inyon-linux-x64\n`, base())).rejects.toThrow('has no inyon-darwin-x64')
  await expect(releaseFile('inyon-linux-x64', `${sha(BUILD)}  inyon-linux-x64\n${sha(GZ)}  inyon-linux-x64.gz\n`, `${base()}/gone`)).rejects.toThrow('Could not download inyon-linux-x64.gz (404)')
})
