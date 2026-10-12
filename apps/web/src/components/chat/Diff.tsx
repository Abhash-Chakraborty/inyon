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

export function Diff({ hunks, maxLines = 400 }: { hunks: Hunk[]; maxLines?: number }) {
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
              if (shown >= maxLines) {
                hidden++
                continue
              }
              shown++
              const sign = line[0]
              const text = line.slice(1)
              const add = sign === '+'
              const del = sign === '-'
              if (sign === '\\') continue
              const oldNo = add ? '' : o++
              const newNo = del ? '' : n++
              rows.push(
                <tr key={`${hi}-${li}`} className={add ? 'bg-[var(--diff-add)]' : del ? 'bg-[var(--diff-del)]' : ''}>
                  <td className="w-[1%] select-none whitespace-nowrap px-2 text-right text-fg-3/80">{del ? oldNo : newNo}</td>
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
