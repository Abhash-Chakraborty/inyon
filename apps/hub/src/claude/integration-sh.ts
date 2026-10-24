// Shell shared by the integration scripts and the probe (kept apart to avoid an import cycle).

/** Bump when the scripts change; the probe reports older copies as outdated. */
export const MARKER_VERSION = 7
export const MARKER = `inyon-integration ${MARKER_VERSION}`

/**
 * Shell test: the script in file $1 is this version of the integration or a newer one. A phone
 * still on an older app then leaves scripts a newer one wrote alone, instead of the two putting
 * their own version back in turn.
 */
export const CURRENT_SH = `current() { v=$(sed -n 's/^# inyon-integration \\([0-9][0-9]*\\)$/\\1/p' "$1" 2>/dev/null | head -n 1); [ -n "$v" ] && [ "$v" -ge ${MARKER_VERSION} ]; }`

/**
 * Sets $pane to the pane the script runs in, as the hub names it. psmux (Windows) numbers panes per
 * session, so every session has a %1: the hub calls them %<session>.<pane> (win-prelude.sh), and the
 * scripts ask psmux for the session id so two sessions don't share one file. If psmux doesn't answer,
 * the plain %1 is no worse than before: the hub has no pane by that name and ignores it.
 */
export const PANE_SH = `pane=\${TMUX_PANE:-}
if [ -n "$pane" ] && [ -n "\${PSMUX_SESSION:-}" ]; then
  for _ in 1 2; do s=$(tmux display -p -t "$PSMUX_SESSION" '#{session_id}' 2>/dev/null | tr -d '$\\r'); [ -n "$s" ] && break; done
  case $s in ''|*[!0-9]*) ;; *) pane="%$s.\${pane#%}" ;; esac
fi`

/**
 * Inyon was called Tether: moves ~/.tether to ~/.inyon once and leaves a link at the old path, so
 * hooks and status lines still pointing there keep working until they're rewritten (legacy.ts does
 * the same for the hub's own machine). A second check keeps the link out of a folder a hook made
 * in between.
 */
export const MOVE_OLD_FOLDER_SH = `if [ -d "$HOME/.tether" ] && [ ! -L "$HOME/.tether" ] && [ ! -e "$HOME/.inyon" ]; then mv "$HOME/.tether" "$HOME/.inyon" && { [ -e "$HOME/.tether" ] || ln -s "$HOME/.inyon" "$HOME/.tether"; }; fi`

/**
 * Shell that prints the account a Claude config file is signed in to (oauthAccount.accountUuid),
 * or "-". Append the file as an argument; the status line wrapper and the probe both use it.
 */
export const ACCOUNT_SH = `a() { v=$(tr -d '\\n\\r' < "$1" 2>/dev/null | grep -o '"oauthAccount": *{[^}]*' | grep -o '"accountUuid": *"[^"]*"' | head -n 1 | sed 's/.*"\\([^"]*\\)"$/\\1/'); echo "\${v:--}"; }; a`
