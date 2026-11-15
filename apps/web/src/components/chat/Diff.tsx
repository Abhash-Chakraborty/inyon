import { useMemo } from 'react'
import { structuredPatch } from 'diff'
import type { ToolResultMeta } from '@inyon/protocol'

type Hunk = NonNullable<ToolResultMeta['patch']>[number]

/** Hunks from the tool result when Claude Code recorded them, otherwise computed from the edit. */
export function useHunks(meta: ToolResultMeta | undefined, input: any): Hunk[] {
  return useMemo(() => {
    if (meta?.patch?.length) return meta.patch
    const edits: { old_string?: string; new_string?: string }[] =
      Array.isArray(input?.edits) ? input.edits : input?.old_string !== undefined ? [input] : []
    if (edits.length) {
      return edits.flatMap((e) => structuredPatch('a', 'b', e.old_string ?? '', e.new_string ?? '', '', '', { context: 3 }).hunks)
    }
    if (typeof input?.content === 'string') {
      const lines = input.content.split('\n')
      return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l: string) => `+${l}`) }]
    }
    return []
  }, [meta, input])
}

/** A diff line someone can comment on: its number (in the old file for a removed line) and its text. */
export interface DiffLine {
  no: number
  removed: boolean
  text: string
}

/** One side of a row in a side-by-side diff: a line of the old file (left) or the new one (right). */
export interface SideLine {
  no: number
  kind: 'same' | 'add' | 'del'
  text: string
}

/** A row of a side-by-side diff; `gap` marks the break between two hunks. */
export type SplitRow = { gap: true } | { gap?: false; left?: SideLine; right?: SideLine }

/**
 * A unified diff laid out side by side: unchanged lines on both sides, and each run of removed
 * lines next to the added lines that follow it, pair by pair, with a blank cell where one side
 * runs longer. At most `maxLines` diff lines are placed; `hidden` counts the rest.
 */
export function splitRows(hunks: Hunk[], maxLines = 400): { rows: SplitRow[]; hidden: number } {
  const rows: SplitRow[] = []
  let shown = 0
  let hidden = 0
  for (const [hi, h] of hunks.entries()) {
    if (hi > 0) rows.push({ gap: true })
    let o = h.oldStart
    let n = h.newStart
    let dels: SideLine[] = []
    let adds: SideLine[] = []
    const flush = () => {
      for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push({ left: dels[i], right: adds[i] })
      dels = []
      adds = []
    }
    for (const line of h.lines) {
      const sign = line[0]
      if (sign === '\\') continue
      if (shown >= maxLines) {
        hidden++
        continue
      }
      shown++
      const text = line.slice(1)
      if (sign === '-') {
        // a removed line after added ones starts a new pair of runs
        if (adds.length) flush()
        dels.push({ no: o++, kind: 'del', text })
      } else if (sign === '+') adds.push({ no: n++, kind: 'add', text })
      else {
        flush()
        rows.push({ left: { no: o++, kind: 'same', text }, right: { no: n++, kind: 'same', text } })
      }
    }
    flush()
  }
  return { rows, hidden }
}

/** A diff side by side: the old file on the left, the new one on the right. Long lines wrap. */
function SplitDiff({ hunks, maxLines, onLine, marked }: { hunks: Hunk[]; maxLines: number; onLine?: (l: DiffLine) => void; marked?: (l: DiffLine) => boolean }) {
  const { rows, hidden } = useMemo(() => splitRows(hunks, maxLines), [hunks, maxLines])
  const cell = (s: SideLine | undefined, side: 'left' | 'right') => {
    const bg = !s ? 'bg-sunken/40' : s.kind === 'add' ? 'bg-[var(--diff-add)]' : s.kind === 'del' ? 'bg-[var(--diff-del)]' : ''
    // a comment goes on a removed line (left) or on a line of the new file (right), as in one column
    const l: DiffLine | undefined = s && (side === 'left' ? s.kind === 'del' : true) ? { no: s.no, removed: s.kind === 'del', text: s.text } : undefined
    const on = l && marked?.(l)
    return (
      <>
        <td className={`select-none whitespace-nowrap p-0 text-right align-top text-fg-3/80 ${bg} ${side === 'right' ? 'border-l border-line' : ''}`}>
          {s && l && onLine ? (
            <button
              type="button"
              onClick={() => onLine(l)}
              title="Comment on this line"
              aria-label={`Comment on ${l.removed ? 'removed ' : ''}line ${l.no}`}
              className={`block w-full px-2 text-right hover:bg-accent-soft hover:text-fg ${on ? 'bg-accent-soft font-semibold text-accent-text' : ''}`}
            >
              {s.no}
            </button>
          ) : (
            s && <span className="px-2">{s.no}</span>
          )}
        </td>
        <td className={`select-none pl-1 align-top ${bg} ${s?.kind === 'add' ? 'text-ok' : s?.kind === 'del' ? 'text-danger' : 'text-fg-3'}`}>{s?.kind === 'add' ? '+' : s?.kind === 'del' ? '−' : ' '}</td>
        <td className={`whitespace-pre-wrap [overflow-wrap:anywhere] pr-3 pl-1.5 align-top ${bg}`}>{s ? s.text || ' ' : ''}</td>
      </>
    )
  }
  return (
    <div data-layout="split" className="font-mono text-[12.5px] leading-[1.55]">
      <table className="w-full table-fixed border-collapse">
        <colgroup>
          <col className="w-11" />
          <col className="w-4" />
          <col />
          <col className="w-11" />
          <col className="w-4" />
          <col />
        </colgroup>
        <tbody>
          {rows.map((r, i) =>
            r.gap ? (
              <tr key={i}>
                <td colSpan={6} className="select-none bg-sunken/60 px-3 py-0.5 text-center text-[12px] text-fg-3">
                  ⋯
                </td>
              </tr>
            ) : (
              <tr key={i}>
                {cell(r.left, 'left')}
                {cell(r.right, 'right')}
              </tr>
            ),
          )}
        </tbody>
      </table>
      {hidden > 0 && <div className="border-t border-line px-3 py-1.5 font-sans text-xs text-fg-3">{hidden} more lines</div>}
    </div>
  )
}

export function Diff({ hunks, maxLines = 400, onLine, marked, split }: {
  hunks: Hunk[]
  maxLines?: number
  /** makes each line number a button that comments on that line */
  onLine?: (l: DiffLine) => void
  /** lines that already have a comment */
  marked?: (l: DiffLine) => boolean
  /** the old and new file side by side instead of one column */
  split?: boolean
}) {
  if (split) return <SplitDiff hunks={hunks} maxLines={maxLines} onLine={onLine} marked={marked} />
  let shown = 0
  let hidden = 0
  return (
    <div className="overflow-x-auto font-mono text-[12.5px] leading-[1.55]">
      <table className="w-full border-collapse">
        <tbody>
          {hunks.map((h, hi) => {
            let o = h.oldStart
            let n = h.newStart
            const rows = []
            if (hi > 0) {
              rows.push(
                <tr key={`gap${hi}`}>
                  <td colSpan={3} className="select-none bg-sunken/60 px-3 py-0.5 text-center text-[12px] text-fg-3">
                    ⋯
                  </td>
                </tr>,
              )
            }
            for (const [li, line] of h.lines.entries()) {
              const sign = line[0]
              // "\ No newline at end of file" is not a line of the file: it neither shows nor counts
              if (sign === '\\') continue
              if (shown >= maxLines) {
                hidden++
                continue
              }
              shown++
              const text = line.slice(1)
              const add = sign === '+'
              const del = sign === '-'
              const oldNo = add ? '' : o++
              const newNo = del ? '' : n++
              const l: DiffLine = { no: Number(del ? oldNo : newNo), removed: del, text }
              const on = marked?.(l)
              rows.push(
                <tr key={`${hi}-${li}`} className={add ? 'bg-[var(--diff-add)]' : del ? 'bg-[var(--diff-del)]' : ''}>
                  <td className="w-[1%] select-none whitespace-nowrap p-0 text-right text-fg-3/80">
                    {onLine ? (
                      <button
                        type="button"
                        onClick={() => onLine(l)}
                        title="Comment on this line"
                        aria-label={`Comment on ${l.removed ? 'removed ' : ''}line ${l.no}`}
                        className={`block w-full px-2 text-right hover:bg-accent-soft hover:text-fg ${on ? 'bg-accent-soft font-semibold text-accent-text' : ''}`}
                      >
                        {l.no}
                      </button>
                    ) : (
                      <span className="px-2">{l.no}</span>
                    )}
                  </td>
                  <td className={`w-[1%] select-none pl-1 ${add ? 'text-ok' : del ? 'text-danger' : 'text-fg-3'}`}>{add ? '+' : del ? '−' : ' '}</td>
                  <td className="whitespace-pre pr-4 pl-1.5">{text || ' '}</td>
                </tr>,
              )
            }
            return rows
          })}
        </tbody>
      </table>
      {hidden > 0 && <div className="border-t border-line px-3 py-1.5 font-sans text-xs text-fg-3">{hidden} more lines</div>}
    </div>
  )
}
