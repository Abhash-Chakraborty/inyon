// Shell shared by the integration scripts and the probe (kept apart to avoid an import cycle).

/** Bump when the scripts change; the probe reports older copies as outdated. */
export const MARKER = 'tether-integration 2'

/**
 * Shell that prints the account a Claude config file is signed in to (oauthAccount.accountUuid),
 * or "-". Append the file as an argument; the status line wrapper and the probe both use it.
 */
export const ACCOUNT_SH = `a() { v=$(tr -d '\\n\\r' < "$1" 2>/dev/null | grep -o '"oauthAccount": *{[^}]*' | grep -o '"accountUuid": *"[^"]*"' | head -n 1 | sed 's/.*"\\([^"]*\\)"$/\\1/'); echo "\${v:--}"; }; a`
