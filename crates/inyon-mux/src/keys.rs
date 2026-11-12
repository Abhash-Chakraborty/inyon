//! Key names as `tmux send-keys` takes them (`Enter`, `C-c`, `Up`, `M-x`, `F5`), turned into the
//! bytes a terminal sends for them. A word that names no key is typed as it stands, as tmux does.

/// The bytes for one `send-keys` word.
pub fn key_bytes(word: &str) -> Vec<u8> {
    named(word).unwrap_or_else(|| word.as_bytes().to_vec())
}

/// The bytes `send-keys -H` words stand for (`1b 5b 41`), or which word isn't a byte in hex.
pub fn hex_bytes(words: &[String]) -> Result<Vec<u8>, String> {
    words.iter().map(|w| u8::from_str_radix(w, 16).map_err(|_| format!("not a byte in hex: {w}"))).collect()
}

fn named(word: &str) -> Option<Vec<u8>> {
    // modifiers come first, in any order: C- (Ctrl), M- (Alt, sent as Esc before the key), S- (Shift)
    if let Some(rest) = word.strip_prefix("M-").filter(|r| !r.is_empty()) {
        let mut v = vec![0x1b];
        v.extend(key_bytes(rest));
        return Some(v);
    }
    if let Some(rest) = word.strip_prefix("C-").or_else(|| word.strip_prefix('^')).filter(|r| !r.is_empty()) {
        return ctrl(rest);
    }
    if word == "S-Tab" {
        return Some(b"\x1b[Z".to_vec());
    }
    let s: &[u8] = match word {
        "Enter" | "KPEnter" => b"\r",
        "Escape" => b"\x1b",
        "Tab" => b"\t",
        "BTab" => b"\x1b[Z",
        "Space" => b" ",
        "BSpace" => b"\x7f",
        "Up" => b"\x1b[A",
        "Down" => b"\x1b[B",
        "Right" => b"\x1b[C",
        "Left" => b"\x1b[D",
        "Home" => b"\x1b[1~",
        "End" => b"\x1b[4~",
        "IC" | "Insert" => b"\x1b[2~",
        "DC" | "Delete" => b"\x1b[3~",
        "PPage" | "PageUp" | "PgUp" => b"\x1b[5~",
        "NPage" | "PageDown" | "PgDn" => b"\x1b[6~",
        "F1" => b"\x1bOP",
        "F2" => b"\x1bOQ",
        "F3" => b"\x1bOR",
        "F4" => b"\x1bOS",
        "F5" => b"\x1b[15~",
        "F6" => b"\x1b[17~",
        "F7" => b"\x1b[18~",
        "F8" => b"\x1b[19~",
        "F9" => b"\x1b[20~",
        "F10" => b"\x1b[21~",
        "F11" => b"\x1b[23~",
        "F12" => b"\x1b[24~",
        _ => return None,
    };
    Some(s.to_vec())
}

/// Ctrl with a key: a letter or one of `@ [ \ ] ^ _ ?` gives its control code; a named key stays itself.
fn ctrl(rest: &str) -> Option<Vec<u8>> {
    let mut chars = rest.chars();
    let (c, more) = (chars.next()?, chars.next());
    if more.is_some() {
        // C-Up and the like: no code of their own in a plain terminal, so the key alone
        return named(rest);
    }
    let code = match c {
        'a'..='z' => c as u8 - b'a' + 1,
        'A'..='Z' => c as u8 - b'A' + 1,
        '@' | ' ' => 0,
        '[' => 0x1b,
        '\\' => 0x1c,
        ']' => 0x1d,
        '^' => 0x1e,
        '_' => 0x1f,
        '?' => 0x7f,
        _ => return None,
    };
    Some(vec![code])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_keys_the_hub_presses() {
        assert_eq!(key_bytes("Enter"), b"\r");
        assert_eq!(key_bytes("Escape"), b"\x1b");
        assert_eq!(key_bytes("Up"), b"\x1b[A");
        assert_eq!(key_bytes("Down"), b"\x1b[B");
        assert_eq!(key_bytes("Tab"), b"\t");
        assert_eq!(key_bytes("BTab"), b"\x1b[Z");
        assert_eq!(key_bytes("BSpace"), b"\x7f");
        assert_eq!(key_bytes("Space"), b" ");
    }

    #[test]
    fn ctrl_gives_the_control_code() {
        assert_eq!(key_bytes("C-c"), [3]);
        assert_eq!(key_bytes("C-C"), [3]);
        assert_eq!(key_bytes("C-d"), [4]);
        assert_eq!(key_bytes("C-u"), [0x15]);
        assert_eq!(key_bytes("C-\\"), [0x1c]);
        assert_eq!(key_bytes("C-["), [0x1b]);
        assert_eq!(key_bytes("^c"), [3]);
        // a named key under Ctrl is the key
        assert_eq!(key_bytes("C-Up"), b"\x1b[A");
    }

    #[test]
    fn alt_is_escape_then_the_key() {
        assert_eq!(key_bytes("M-x"), b"\x1bx");
        assert_eq!(key_bytes("M-Enter"), b"\x1b\r");
        assert_eq!(key_bytes("M-C-c"), [0x1b, 3]);
    }

    #[test]
    fn a_word_that_names_no_key_is_typed() {
        assert_eq!(key_bytes("hello"), b"hello");
        assert_eq!(key_bytes("2"), b"2");
        assert_eq!(key_bytes("y"), b"y");
        // a lone modifier prefix is text too
        assert_eq!(key_bytes("C-"), b"C-");
        assert_eq!(key_bytes("안녕"), "안녕".as_bytes());
    }

    #[test]
    fn hex_words_are_bytes() {
        let w = |s: &str| s.split(' ').map(str::to_string).collect::<Vec<_>>();
        // a mouse wheel report, as the terminal view sends it
        assert_eq!(hex_bytes(&w("1b 5b 3c 36 34 3b 31 30 3b 35 4d")).unwrap(), b"\x1b[<64;10;5M");
        assert_eq!(hex_bytes(&w("1b zz")).unwrap_err(), "not a byte in hex: zz");
    }
}
