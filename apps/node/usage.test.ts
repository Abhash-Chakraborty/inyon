import { expect, test } from 'bun:test'
import { ENGINE } from './engine-under-test.ts'

// a long command used to push its description out of line with the rest
test('every line of the help starts its description in the same column', () => {
  const out = Bun.spawnSync([...ENGINE, '--help']).stdout.toString()
  const rows = out.split('\n').filter((l) => /^ {2}\S/.test(l) || /^ {4}--/.test(l))
  expect(rows.length).toBeGreaterThan(10)
  // where the description starts: the first word after a gap of two or more spaces
  const cols = new Set(rows.map((l) => l.search(/(?<=\S {2,})\S/)))
  expect([...cols]).toHaveLength(1)
})
