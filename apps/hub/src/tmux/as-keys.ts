import { shq } from '../hosts/host.ts'

/**
 * For tests: text typed through a buffer (`typeCommand`, fed on stdin) shown as the `send-keys -l`
 * it stands for, so a fake machine reads typing one way however the hub delivers it.
 */
export function asKeys(cmd: string, input?: string): { cmd: string; input?: string } {
  const m = /^(.*?)umask 077; f=\$\(mktemp\) .*? tmux paste-buffer -d -b '[^']*' -t ('[^']*'); r=\$\?; .*?\[ \$r = 0 \]; \}(.*)$/s.exec(cmd)
  if (!m || input === undefined) return { cmd, input }
  return { cmd: `${m[1]}tmux send-keys -t ${m[2]} -l -- ${shq(input)}${m[3]}` }
}
