import clsx from 'clsx'
import { ExternalLink } from 'lucide-react'

/** In place of a frame, on a phone whose WebView would let the page inside reach the app's native side. */
export function FrameRefused({ src, className, style }: { src: string; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={clsx('flex flex-col items-center justify-center gap-3 p-6 text-center', className)} style={style} role="status">
      <p className="max-w-[34ch] text-[13.5px] leading-relaxed text-fg-2">This phone's WebView is too old to show other pages inside Inyon safely. Update Android System WebView, or open it in the browser.</p>
      <a href={src} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[13px] text-fg hover:bg-hover">
        Open in the browser <ExternalLink className="size-3.5" />
      </a>
    </div>
  )
}
