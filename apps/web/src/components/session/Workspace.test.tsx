import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FilesTab, WorkingTree, ReviewBar } from './Workspace.tsx'
import { api } from '../../test/fakes.ts'
import type { GitState } from '../../lib/api.ts'
import { renderSettled as render } from '../../test/render.tsx'
import { appendTo, onCompose } from '../../lib/compose.ts'
import { review, reviewMessage } from '../../lib/review.ts'
import { useStore } from '../../lib/store.ts'

const p = { host: 'box', pane: '%4' }
let composed: string[] = []
let off = () => {}
beforeEach(() => {
  composed = []
  off = onCompose('box', '%4', (t) => composed.push(t))
  review.clear('box:%4')
  useStore.setState({ toasts: [] })
})
afterEach(() => off())

describe('Files', () => {
  test('browses the folder, opens a file and mentions it', async () => {
    api.dir.mockImplementation(async (_h: string, _p: string, path: string) =>
      path === 'src'
        ? { cwd: '/srv/app', path, entries: [{ name: 'main.ts', dir: false, size: 120, mtime: 0 }] }
        : { cwd: '/srv/app', path, entries: [{ name: 'src', dir: true, size: 0, mtime: 0 }, { name: 'README.md', dir: false, size: 2048, mtime: 0 }] },
    )
    api.file.mockImplementation(async (_h: string, _p: string, path: string) => ({ kind: 'text', path, text: 'export const a = 1\n', size: 19, truncated: false }))
    await render(<FilesTab p={p} />)
    expect(screen.getByText('app')).toBeTruthy()
    expect(screen.getByText('2 KB')).toBeTruthy()
    await userEvent.click(screen.getByText('src'))
    expect(api.dir.mock.calls.at(-1)).toEqual(['box', '%4', 'src'])
    await userEvent.click(await screen.findByText('main.ts'))
    expect(api.file.mock.calls.at(-1)).toEqual(['box', '%4', 'src/main.ts'])
    expect((await screen.findByText(/export/)).closest('pre')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Mention/ }))
    expect(composed).toEqual(['@src/main.ts'])
    await userEvent.click(screen.getByRole('button', { name: 'Back to the folder' }))
    expect(await screen.findByText('main.ts')).toBeTruthy()
  })

  test('a binary file says so instead of showing bytes', async () => {
    api.dir.mockImplementation(async () => ({ cwd: '/srv/app', path: '', entries: [{ name: 'a.bin', dir: false, size: 10, mtime: 0 }] }))
    api.file.mockImplementation(async () => ({ kind: 'binary', path: 'a.bin', size: 10 }))
    await render(<FilesTab p={p} />)
    await userEvent.click(screen.getByText('a.bin'))
    expect(await screen.findByText('Not a text file')).toBeTruthy()
  })
})

describe('Working tree', () => {
  const tree: GitState = { repo: true, remote: true, branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0, files: [{ path: 'src/a.ts', status: 'M', add: 1, del: 1 }, { path: 'notes.md', status: '?', add: 0, del: 0 }] }
  const diff = { path: 'src/a.ts', binary: false, hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' keep', '-old', '+new'] }] }

  test('outside a repository it says so', async () => {
    api.git.mockImplementation(async () => ({ repo: false, files: [] }))
    await render(<WorkingTree p={p} poke={0} />)
    expect(screen.getByText('Not a git repository')).toBeTruthy()
  })

  test('shows the branch and files, and comments on a line go into the message together', async () => {
    api.git.mockImplementation(async () => tree)
    api.gitDiff.mockImplementation(async () => diff)
    await render(
      <>
        <WorkingTree p={p} poke={0} />
        <ReviewBar p={p} />
      </>,
    )
    expect(screen.getByText('main')).toBeTruthy()
    expect(screen.getByText('U')).toBeTruthy()
    expect(api.gitDiff.mock.calls.at(-1)).toEqual(['box', '%4', 'src/a.ts'])
    // line 2 is both a removed line (old file) and an added one (new file)
    expect(screen.getByRole('button', { name: 'Comment on removed line 2' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Comment on line 2' }))
    await userEvent.type(screen.getByLabelText('Comment'), 'Keep the old name')
    await userEvent.click(screen.getByRole('button', { name: 'Save comment' }))
    expect(screen.getByText('1 comment')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Add to message' }))
    expect(composed).toHaveLength(1)
    expect(composed[0]).toContain('src/a.ts:2')
    expect(screen.queryByText('1 comment')).toBeNull()
  })

  test('commits everything with your message', async () => {
    api.git.mockImplementation(async () => tree)
    api.gitDiff.mockImplementation(async () => diff)
    api.gitCommit.mockImplementation(async () => ({ commit: 'abc1234' }))
    await render(<WorkingTree p={p} poke={0} />)
    const commit = screen.getByRole('button', { name: 'Commit all' }) as HTMLButtonElement
    expect(commit.disabled).toBe(true)
    await userEvent.type(screen.getByLabelText('Commit message'), 'Rename a')
    await userEvent.click(commit)
    expect(api.gitCommit.mock.calls.at(-1)).toEqual(['box', '%4', 'Rename a', undefined])
    expect(useStore.getState().toasts.map((t) => t.title)).toContain('Committed abc1234')
  })
})

describe('Working tree actions', () => {
  const unstaged: GitState = {
    repo: true,
    remote: false,
    branch: 'main',
    files: [
      { path: 'src/a.ts', status: 'M', add: 1, del: 1, staged: false, unstaged: true },
      { path: '-new file.md', status: '?', add: 0, del: 0, staged: false, unstaged: true },
    ],
  }
  const diff = { path: 'src/a.ts', binary: false, hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' keep', '-old', '+new'] }] }
  beforeEach(() => {
    api.git.mockImplementation(async () => unstaged)
    api.gitDiff.mockImplementation(async () => diff)
  })

  test('stages one file, and Commit then takes only the staged one', async () => {
    const staged: GitState = { ...unstaged, files: [unstaged.files[0]!, { ...unstaged.files[1]!, staged: true, unstaged: false }] }
    api.gitFiles.mockImplementation(async () => staged)
    api.gitCommit.mockImplementation(async () => ({ commit: 'abc1234' }))
    await render(<WorkingTree p={p} poke={0} />)
    expect(screen.queryByRole('region', { name: 'Staged' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Commit all' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Stage -new file.md' }))
    expect(api.gitFiles.mock.calls.at(-1)).toEqual(['box', '%4', 'stage', ['-new file.md'], false])
    const region = await screen.findByRole('region', { name: 'Staged' })
    expect(region.textContent).toContain('-new file.md')
    expect(screen.getByRole('button', { name: 'Unstage -new file.md' })).toBeTruthy()
    await userEvent.type(screen.getByLabelText('Commit message'), 'Add the notes')
    await userEvent.click(screen.getByRole('button', { name: 'Commit 1 staged' }))
    expect(api.gitCommit.mock.calls.at(-1)).toEqual(['box', '%4', 'Add the notes', true])
  })

  test('Stage all and Unstage all name no files', async () => {
    api.gitFiles.mockImplementation(async () => unstaged)
    await render(<WorkingTree p={p} poke={0} />)
    await userEvent.click(screen.getByRole('button', { name: 'Stage all' }))
    expect(api.gitFiles.mock.calls.at(-1)).toEqual(['box', '%4', 'stage', [], true])
  })

  test('with nothing staged Commit all commits everything', async () => {
    api.gitCommit.mockImplementation(async () => ({ commit: 'abc1234' }))
    await render(<WorkingTree p={p} poke={0} />)
    await userEvent.type(screen.getByLabelText('Commit message'), 'All of it')
    await userEvent.click(screen.getByRole('button', { name: 'Commit all' }))
    expect(api.gitCommit.mock.calls.at(-1)).toEqual(['box', '%4', 'All of it', false])
  })

  test('discard asks first, and does nothing when cancelled', async () => {
    const { ConfirmHost } = await import('../Confirm.tsx')
    api.gitFiles.mockImplementation(async () => ({ ...unstaged, files: [unstaged.files[1]!] }))
    await render(
      <>
        <WorkingTree p={p} poke={0} />
        <ConfirmHost />
      </>,
    )
    await userEvent.click(screen.getAllByRole('button', { name: 'Discard' })[0]!)
    expect(await screen.findByText('Discard your changes to a.ts?')).toBeTruthy()
    expect(screen.getByText("This can't be undone.")).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.gitFiles).not.toHaveBeenCalled()

    await userEvent.click(screen.getAllByRole('button', { name: 'Discard' })[0]!)
    const sheet = await screen.findByText('Discard your changes to a.ts?')
    const yes = within(sheet.closest('[role=dialog]') as HTMLElement).getByRole('button', { name: 'Discard' })
    await userEvent.click(yes)
    expect(api.gitFiles.mock.calls.at(-1)).toEqual(['box', '%4', 'discard', ['src/a.ts'], false])
    expect((await screen.findAllByText('-new file.md')).length).toBeGreaterThan(0)
    expect(useStore.getState().toasts.map((t) => t.title)).toContain('Changes discarded')
  })

  test('a renamed file is discarded by both its paths, from its right-click menu', async () => {
    const { ConfirmHost } = await import('../Confirm.tsx')
    const { ContextMenuHost } = await import('../ui/ContextMenu.tsx')
    const { fireEvent } = await import('@testing-library/react')
    api.git.mockImplementation(async () => ({ ...unstaged, files: [{ path: 'new.ts', from: 'old.ts', status: 'R', add: 0, del: 0, staged: true, unstaged: false }] }))
    api.gitFiles.mockImplementation(async () => ({ ...unstaged, files: [] }))
    await render(
      <>
        <WorkingTree p={p} poke={0} />
        <ConfirmHost />
        <ContextMenuHost />
      </>,
    )
    fireEvent.contextMenu(screen.getAllByText('new.ts')[0]!, { clientX: 10, clientY: 10 })
    expect(screen.getByRole('menuitem', { name: /Unstage/ })).toBeTruthy()
    await userEvent.click(screen.getByRole('menuitem', { name: /Discard changes/ }))
    expect(await screen.findByText("It goes back to old.ts. This can't be undone.")).toBeTruthy()
    const sheet = screen.getByText('Discard your changes to new.ts?').closest('[role=dialog]') as HTMLElement
    await userEvent.click(within(sheet).getByRole('button', { name: 'Discard' }))
    expect(api.gitFiles.mock.calls.at(-1)).toEqual(['box', '%4', 'discard', ['new.ts', 'old.ts'], false])
    expect(await screen.findByText('No changes')).toBeTruthy()
  })

  test('Draft fills the message box, and Undo brings back what you had typed', async () => {
    api.gitDraft.mockImplementation(async () => ({ message: 'Update 2 files\n\n- src/a.ts\n- -new file.md (new)' }))
    await render(<WorkingTree p={p} poke={0} />)
    const box = screen.getByLabelText('Commit message') as HTMLTextAreaElement
    await userEvent.type(box, 'my words')
    await userEvent.click(screen.getByRole('button', { name: /Draft/ }))
    expect(api.gitDraft.mock.calls.at(-1)).toEqual(['box', '%4'])
    expect(box.value).toBe('Update 2 files\n\n- src/a.ts\n- -new file.md (new)')
    expect(Number(box.rows)).toBe(4)
    const t = useStore.getState().toasts.find((x) => x.title === 'Your message was replaced with a draft')
    expect(t?.action?.label).toBe('Undo')
    await act(async () => t!.action!.onSelect())
    expect(box.value).toBe('my words')
  })

  test('an older hub that reports no staging gets no stage or discard buttons', async () => {
    api.git.mockImplementation(async () => ({ repo: true, branch: 'main', files: [{ path: 'src/a.ts', status: 'M', add: 1, del: 1 }] }))
    await render(<WorkingTree p={p} poke={0} />)
    expect(screen.queryByRole('button', { name: /Stage/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Discard/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Commit all' })).toBeTruthy()
  })
})

describe('Diff layout', () => {
  const wide = (on: boolean) => {
    const was = window.matchMedia
    window.matchMedia = ((q: string) => ({ matches: on && q.includes('min-width: 900px'), media: q, addEventListener() {}, removeEventListener() {} })) as any
    return () => void (window.matchMedia = was)
  }
  beforeEach(() => {
    useStore.getState().setSettings({ diffView: 'unified' })
    try {
      localStorage.setItem('inyon.changes', 'tree')
    } catch {}
    api.git.mockImplementation(async () => ({ repo: true, branch: 'main', files: [{ path: 'src/a.ts', status: 'M', add: 1, del: 1, staged: false, unstaged: true }] }))
    api.gitDiff.mockImplementation(async () => ({ path: 'src/a.ts', binary: false, hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' keep', '-old', '+new'] }] }))
  })
  afterEach(() => {
    try {
      localStorage.removeItem('inyon.changes')
    } catch {}
  })

  test('on a wide screen the diff can go side by side, and the pick is kept', async () => {
    const restore = wide(true)
    try {
      const { ChangesTab } = await import('./Panels.tsx')
      const { container } = await render(<ChangesTab items={[]} p={p} />)
      await screen.findByText('keep')
      expect(container.querySelector('[data-layout=split]')).toBeNull()
      await userEvent.click(screen.getByRole('radio', { name: 'Side by side' }))
      expect(useStore.getState().settings.diffView).toBe('split')
      expect(JSON.parse(localStorage.getItem('inyon.settings.v2') || '{}').diffView).toBe('split')
      expect(container.querySelector('[data-layout=split]')).toBeTruthy()
      // a comment still goes on the removed line, from the left side
      expect(screen.getByRole('button', { name: 'Comment on removed line 2' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Comment on line 2' })).toBeTruthy()
    } finally {
      restore()
    }
  })

  test('under 900 px there is no switch and the diff stays in one column', async () => {
    useStore.getState().setSettings({ diffView: 'split' })
    const restore = wide(false)
    try {
      const { ChangesTab } = await import('./Panels.tsx')
      const { container } = await render(<ChangesTab items={[]} p={p} />)
      await screen.findByText('keep')
      expect(screen.queryByRole('radio', { name: 'Side by side' })).toBeNull()
      expect(container.querySelector('[data-layout=split]')).toBeNull()
    } finally {
      restore()
    }
  })
})

test('review comments read as one message, file by file and in line order', () => {
  expect(
    reviewMessage([
      { file: 'b.ts', line: 9, removed: false, code: '  x()', text: 'Why?' },
      { file: 'a.ts', line: 4, removed: true, code: 'old()', text: 'Keep this' },
      { file: 'b.ts', line: 2, removed: false, code: '', text: 'Blank line here' },
    ]),
  ).toBe('Comments on your changes:\n\nb.ts:2\n> (empty line)\nBlank line here\n\nb.ts:9\n> x()\nWhy?\n\na.ts:4 (removed line)\n> old()\nKeep this')
})

test('added text goes after the draft, on its own paragraph when it has several lines', () => {
  expect(appendTo('', '@a.ts')).toBe('@a.ts')
  expect(appendTo('look at ', '@a.ts')).toBe('look at @a.ts')
  expect(appendTo('fix this', 'one\ntwo')).toBe('fix this\n\none\ntwo')
})

test('right-clicking a file offers to open it, mention it or copy its path', async () => {
  const { ContextMenuHost } = await import('../ui/ContextMenu.tsx')
  const { fireEvent } = await import('@testing-library/react')
  api.dir.mockImplementation(async () => ({ cwd: '/srv/app', path: '', entries: [{ name: 'main.ts', dir: false, size: 1, mtime: 0 }] }))
  await render(
    <>
      <FilesTab p={p} />
      <ContextMenuHost />
    </>,
  )
  fireEvent.contextMenu(screen.getByText('main.ts'), { clientX: 10, clientY: 10 })
  expect(screen.getByRole('menuitem', { name: /Open/ })).toBeTruthy()
  expect(screen.getByRole('menuitem', { name: /Copy path/ })).toBeTruthy()
  await userEvent.click(screen.getByRole('menuitem', { name: /Mention in message/ }))
  expect(composed).toEqual(['@main.ts'])
})

test("This chat with no edits points to the working tree, where edits made through commands show", async () => {
  const { ChangesTab } = await import('./Panels.tsx')
  try {
    localStorage.removeItem('inyon.changes')
  } catch {}
  api.git.mockImplementation(async () => ({ repo: true, branch: 'main', files: [{ path: 'test/cart.test.js', status: 'M', add: 6, del: 1 }] }))
  api.gitDiff.mockImplementation(async () => ({ path: 'test/cart.test.js', binary: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' a', '+b'] }] }))
  await render(<ChangesTab items={[]} p={p} />)
  expect(screen.getByText('No changes yet')).toBeTruthy()
  expect(screen.getByText(/Edits it makes through commands show under Working tree/)).toBeTruthy()
  await userEvent.click(screen.getByRole('button', { name: 'Show working tree' }))
  expect(await screen.findByText('cart.test.js', { exact: false })).toBeTruthy()
  try {
    localStorage.removeItem('inyon.changes')
  } catch {}
})
