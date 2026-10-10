import { createContext, memo, useContext, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import clsx from 'clsx'
import { Check, Copy } from 'lucide-react'
import { copyText } from '../../lib/clipboard.ts'
import { toast } from '../../lib/store.ts'

/** Reply font for the agent whose session is on screen. */
export const ReplyFont = createContext<'serif' | 'sans' | 'mono'>('sans')

export function CopyButton({ text, className, label = 'Copy' }: { text: string; className?: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={clsx('inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-fg-3 transition-colors hover:bg-hover hover:text-fg', className)}
      onClick={async (e) => {
        e.stopPropagation()
        if (!await copyText(text)) {
          toast({ title: 'Could not copy', body: 'Select the message text to copy it manually.', tone: 'error' })
          return
        }
        setDone(true)
        setTimeout(() => setDone(false), 1400)
      }}
    >
      {done ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
    </button>
  )
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as any).props.children)
  return ''
}

const components: Components = {
  pre({ children }) {
    const child: any = Array.isArray(children) ? children[0] : children
    const cls: string = child?.props?.className ?? ''
    const lang = cls.match(/language-([\w+#-]+)/)?.[1]
    const code = textOf(child?.props?.children).replace(/\n$/, '')
    return (
      <div className="group/code my-3 overflow-hidden rounded-[10px] border border-line bg-code">
        <div className="flex h-8 items-center justify-between border-b border-line pl-3.5 pr-1.5 font-sans text-[11.5px] text-fg-3">
          <span>{lang ?? 'text'}</span>
          <CopyButton text={code} />
        </div>
        <pre className="overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-[1.65]">{children}</pre>
      </div>
    )
  },
  table({ children }) {
    return (
      <div className="table-wrap">
        <table>{children}</table>
      </div>
    )
  },
  a({ children, href }) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    )
  },
  // agent output can't load outside images: a prompt-injected agent could put data in the URL
  img({ src, alt }) {
    const url = typeof src === 'string' ? src : ''
    if (/^(data:image\/|blob:|\/)/.test(url)) return <img src={url} alt={alt ?? ''} className="max-w-full rounded-[8px]" />
    return /^https?:\/\//.test(url) ? (
      <a href={url} target="_blank" rel="noreferrer noopener">{alt || url}</a>
    ) : (
      <span>{alt}</span>
    )
  },
}

export const Markdown = memo(function Markdown({ text, className, sans }: { text: string; className?: string; sans?: boolean }) {
  const font = useContext(ReplyFont)
  return (
    <div className={clsx('prose-reply', !sans && font !== 'sans' && `reply-${font}`, className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
