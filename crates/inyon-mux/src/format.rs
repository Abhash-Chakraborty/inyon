//! tmux's format strings, as far as the hub writes them: `#{name}` for a value, `##` for a `#`, and
//! `#{?name,yes,no}` for one of two texts. A name the keeper doesn't know gives nothing, as in tmux.

/// `fmt` with each `#{name}` replaced by what `value` gives for it.
pub fn expand(fmt: &str, value: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(fmt.len());
    let b = fmt.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'#' && i + 1 < b.len() {
            match b[i + 1] {
                b'#' => {
                    out.push('#');
                    i += 2;
                    continue;
                }
                b'{' => {
                    if let Some(end) = closing(fmt, i + 2) {
                        out.push_str(&braces(&fmt[i + 2..end], value));
                        i = end + 1;
                        continue;
                    }
                }
                _ => {}
            }
        }
        // one whole character, whatever its width
        let ch = fmt[i..].chars().next().unwrap_or('#');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Where the `}` that closes a `#{` opened just before `from` is, counting the ones nested inside.
fn closing(s: &str, from: usize) -> Option<usize> {
    let b = s.as_bytes();
    let mut depth = 1;
    let mut i = from;
    while i < b.len() {
        match b[i] {
            b'#' if i + 1 < b.len() && b[i + 1] == b'{' => {
                depth += 1;
                i += 1;
            }
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// What stands between `#{` and `}`: a name, or `?name,yes,no`.
fn braces(inner: &str, value: &dyn Fn(&str) -> Option<String>) -> String {
    let Some(rest) = inner.strip_prefix('?') else { return value(inner).unwrap_or_default() };
    let parts = split_top(rest);
    let on = parts.first().map(|c| expand_cond(c, value)).unwrap_or_default();
    let yes = !on.is_empty() && on != "0";
    let pick = if yes { parts.get(1) } else { parts.get(2) };
    pick.map(|p| expand(p, value)).unwrap_or_default()
}

/// A condition is a name, or a format of its own.
fn expand_cond(c: &str, value: &dyn Fn(&str) -> Option<String>) -> String {
    if c.contains("#{") {
        expand(c, value)
    } else {
        value(c).unwrap_or_default()
    }
}

/// `a,b,c` split at the commas that aren't inside a nested `#{…}`.
fn split_top(s: &str) -> Vec<&str> {
    let b = s.as_bytes();
    let (mut depth, mut start, mut out) = (0usize, 0usize, Vec::new());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'#' if i + 1 < b.len() && b[i + 1] == b'{' => {
                depth += 1;
                i += 1;
            }
            b'}' if depth > 0 => depth -= 1,
            b',' if depth == 0 => {
                out.push(&s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    out.push(&s[start..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane(name: &str) -> Option<String> {
        Some(
            match name {
                "pane_id" => "%3",
                "session_name" => "main",
                "pane_title" => "✳ Fix the test",
                "pane_active" => "1",
                "pane_dead" => "0",
                "window_index" => "0",
                "empty" => "",
                _ => return None,
            }
            .to_string(),
        )
    }

    #[test]
    fn names_become_their_values_and_the_rest_stays() {
        // the line the hub lists panes with: fields between a separator it picks
        assert_eq!(expand("#{session_name}|#{window_index}|#{pane_id}|#{pane_title}", &pane), "main|0|%3|✳ Fix the test");
        assert_eq!(expand("#{session_name}:#{window_index}.x", &pane), "main:0.x");
        assert_eq!(expand("no names here", &pane), "no names here");
    }

    #[test]
    fn an_unknown_name_gives_nothing_as_in_tmux() {
        assert_eq!(expand("[#{client_control_mode}]", &pane), "[]");
    }

    #[test]
    fn two_hashes_are_one_and_a_stray_one_stays() {
        assert_eq!(expand("100## done", &pane), "100# done");
        assert_eq!(expand("#", &pane), "#");
        assert_eq!(expand("a #(date) b", &pane), "a #(date) b");
        // a brace that never closes is text
        assert_eq!(expand("#{pane_id", &pane), "#{pane_id");
    }

    #[test]
    fn a_question_mark_picks_one_of_two() {
        assert_eq!(expand("#{?pane_active,active,idle}", &pane), "active");
        assert_eq!(expand("#{?pane_dead,dead,alive}", &pane), "alive");
        assert_eq!(expand("#{?empty,set,unset}", &pane), "unset");
        assert_eq!(expand("#{?missing,set,unset}", &pane), "unset");
        // the texts are formats too, and may hold commas inside their own braces
        assert_eq!(expand("#{?pane_active,#{pane_id} on #{session_name},-}", &pane), "%3 on main");
        assert_eq!(expand("#{?pane_dead,x,#{?pane_active,a,b}}", &pane), "a");
        // with no "no" text, a false condition gives nothing
        assert_eq!(expand("[#{?pane_dead,dead}]", &pane), "[]");
    }

    #[test]
    fn text_in_any_script_passes_through_whole() {
        assert_eq!(expand("세션 #{pane_id} 🪁", &pane), "세션 %3 🪁");
    }
}
