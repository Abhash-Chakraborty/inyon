import { expect, test } from 'bun:test'
import { nodeRoutes, targetOf, updateScript } from './node-dist.ts'

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
