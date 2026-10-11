import { expect, test } from 'bun:test'
import { render } from '@testing-library/react'
import { Markdown } from './Markdown.tsx'

const srcs = (text: string) => [...render(<Markdown text={text} />).container.querySelectorAll('img')].map((i) => i.getAttribute('src'))

test('agent output shows images from this site only', () => {
  expect(srcs('![a](/api/hosts/x/file.png)')).toEqual(['/api/hosts/x/file.png'])
  // "//host/…" is another site, not a path here
  for (const url of ['//evil.example/x.png?d=secret', 'https://evil.example/x.png']) expect(srcs(`![a](${url})`)).toEqual([])
  expect(render(<Markdown text="![leak](//evil.example/x.png)" />).container.textContent).toContain('leak')
})
