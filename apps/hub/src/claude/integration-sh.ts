// Shell shared by the integration scripts and the probe (kept apart to avoid an import cycle).

/** Bump when the scripts change; the probe reports older copies as outdated. */
export const MARKER = 'inyon-integration 5'

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
