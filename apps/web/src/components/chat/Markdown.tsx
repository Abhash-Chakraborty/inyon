import { memo, useContext, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import clsx from 'clsx'

export { CopyButton, ReplyFont } from './copy.tsx'
import { CopyButton, ReplyFont } from './copy.tsx'

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
    // a path on this site, but not "//host/…", which is another site
    if (/^(data:image\/|blob:|\/(?![/\\]))/.test(url)) return <img src={url} alt={alt ?? ''} className="max-w-full rounded-[8px]" />
    return /^https?:\/\//.test(url) ? (
      <a href={url} target="_blank" rel="noreferrer noopener">{alt || url}</a>
    ) : (
      <span>{alt}</span>
    )
  },
}

/** The languages agents print most; the full set roughly doubles this chunk. Others show plain. */
const LANGUAGES = { bash, css, diff, go, java, javascript, json, kotlin, markdown, python, rust, shell, sql, swift, typescript, xml, yaml }
const HIGHLIGHT = [[rehypeHighlight, { detect: false, ignoreMissing: true, languages: LANGUAGES, aliases: { bash: ['sh', 'zsh'], javascript: ['js', 'jsx', 'mjs'], typescript: ['ts', 'tsx'], xml: ['html', 'svg'], yaml: ['yml'], python: ['py'], shell: ['console'] } }]] as any

export const Markdown = memo(function Markdown({ text, className, sans }: { text: string; className?: string; sans?: boolean }) {
  const font = useContext(ReplyFont)
  return (
    <div className={clsx('prose-reply', !sans && font !== 'sans' && `reply-${font}`, className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={HIGHLIGHT} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
