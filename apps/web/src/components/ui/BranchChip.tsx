import clsx from 'clsx'
import { GitBranch } from 'lucide-react'

/** The branch of a session that works in a git worktree Inyon made for it. */
export function BranchChip({ branch, className }: { branch: string; className?: string }) {
  return (
    <span
      title={`In a worktree on ${branch}`}
      className={clsx('inline-flex min-w-0 shrink items-center gap-1 rounded-full border border-line px-1.5 font-mono text-[12px] leading-[18px] text-fg-2', className)}
    >
      <GitBranch className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{branch}</span>
    </span>
  )
}
