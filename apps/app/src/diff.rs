//! Diffs as the web app draws them (chat/Diff.tsx): hunks from the tool result when Claude Code
//! recorded them, otherwise worked out from the edit, and the rows they show, each line with its
//! number (in the old file for a removed line, the new one otherwise), its sign and its text.

use inyon_protocol::PatchHunk;

/// Lines of context around each change, as `structuredPatch` keeps by default.
pub const CONTEXT: usize = 3;
/// Rows drawn before the rest is summed up as "N more lines".
pub const MAX_LINES: usize = 400;
/// Above this many line pairs an edit isn't compared line by line: it shows as all removed, then
/// all added, which is still right, only less tidy.
const MAX_CELLS: usize = 4_000_000;

/// A run of changed lines with the context around it. `lines` start with ` `, `+`, `-` or `\`.
#[derive(Debug, Clone, PartialEq)]
pub struct Hunk {
    pub old_start: u32,
    pub new_start: u32,
    pub lines: Vec<String>,
}

impl From<&PatchHunk> for Hunk {
    fn from(h: &PatchHunk) -> Hunk {
        Hunk { old_start: h.old_start.0.max(0.0) as u32, new_start: h.new_start.0.max(0.0) as u32, lines: h.lines.clone() }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sign {
    Same,
    Add,
    Del,
}

/// One row of a drawn diff.
#[derive(Debug, Clone, PartialEq)]
pub enum Row {
    /// Between two hunks: the file goes on, unchanged.
    Gap,
    Line {
        no: u32,
        sign: Sign,
        text: String,
    },
}

/// What a diff shows: its rows, and how many lines past [`MAX_LINES`] it leaves out.
#[derive(Debug, Clone, PartialEq)]
pub struct Drawn {
    pub rows: Vec<Row>,
    pub hidden: usize,
}

/// The rows of `hunks`, numbered, at most `max` lines of them.
pub fn rows(hunks: &[Hunk], max: usize) -> Drawn {
    let (mut rows, mut shown, mut hidden) = (Vec::new(), 0usize, 0usize);
    for (i, h) in hunks.iter().enumerate() {
        // a hunk past the limit shows nothing, so it needs no gap before it either
        if i > 0 && shown < max {
            rows.push(Row::Gap);
        }
        let (mut old, mut new) = (h.old_start, h.new_start);
        for line in &h.lines {
            let mut chars = line.chars();
            let sign = match chars.next() {
                Some('+') => Sign::Add,
                Some('-') => Sign::Del,
                // "\ No newline at end of file" is not a line of the file: it neither shows nor counts
                Some('\\') => continue,
                _ => Sign::Same,
            };
            if shown >= max {
                hidden += 1;
                continue;
            }
            shown += 1;
            let no = match sign {
                Sign::Del => {
                    old += 1;
                    old - 1
                }
                Sign::Add => {
                    new += 1;
                    new - 1
                }
                Sign::Same => {
                    old += 1;
                    new += 1;
                    new - 1
                }
            };
            rows.push(Row::Line { no, sign, text: chars.as_str().to_string() });
        }
    }
    Drawn { rows, hidden }
}

/// A text's lines the way `diff` splits them: none for an empty text, and no empty last line for a
/// text that ends in a newline.
fn split(s: &str) -> Vec<&str> {
    if s.is_empty() {
        return vec![];
    }
    let s = s.strip_suffix('\n').unwrap_or(s);
    s.split('\n').collect()
}

/// What follows a last line that has no newline, as unified diffs mark it.
const NO_NEWLINE: &str = "\\ No newline at end of file";

/// The hunks that turn `old` into `new`, with `context` unchanged lines around each change, numbered
/// from the first line of `old` and `new` (as `structuredPatch` numbers them).
pub fn structured(old: &str, new: &str, context: usize) -> Vec<Hunk> {
    // each line keeps its newline, so a last line that gains or loses one counts as changed
    let (a, b): (Vec<&str>, Vec<&str>) = (old.split_inclusive('\n').collect(), new.split_inclusive('\n').collect());
    let ops = line_ops(&a, &b);
    // where each op sits in the old and the new text, counted before it
    let mut at = Vec::with_capacity(ops.len() + 1);
    let (mut o, mut n) = (0u32, 0u32);
    for (sign, _) in &ops {
        at.push((o, n));
        match sign {
            Sign::Same => {
                o += 1;
                n += 1;
            }
            Sign::Del => o += 1,
            Sign::Add => n += 1,
        }
    }
    let changes: Vec<usize> = ops.iter().enumerate().filter(|(_, (s, _))| *s != Sign::Same).map(|(i, _)| i).collect();
    let mut hunks = Vec::new();
    let mut i = 0;
    while i < changes.len() {
        // changes closer than twice the context share a hunk
        let mut j = i;
        while j + 1 < changes.len() && changes[j + 1] - changes[j] <= 2 * context + 1 {
            j += 1;
        }
        let from = changes[i].saturating_sub(context);
        let to = (changes[j] + context + 1).min(ops.len());
        let (o0, n0) = at[from];
        let mut lines = Vec::with_capacity(to - from);
        for (s, t) in &ops[from..to] {
            let c = match s {
                Sign::Same => ' ',
                Sign::Add => '+',
                Sign::Del => '-',
            };
            match t.strip_suffix('\n') {
                Some(t) => lines.push(format!("{c}{t}")),
                None => {
                    lines.push(format!("{c}{t}"));
                    lines.push(NO_NEWLINE.to_string());
                }
            }
        }
        let olds = lines.iter().filter(|l| l.starts_with([' ', '-'])).count();
        let news = lines.iter().filter(|l| l.starts_with([' ', '+'])).count();
        // a side with no lines starts before its first line, as unified diffs write it
        hunks.push(Hunk { old_start: if olds == 0 { o0 } else { o0 + 1 }, new_start: if news == 0 { n0 } else { n0 + 1 }, lines });
        i = j + 1;
    }
    hunks
}

/// The lines of `a` and `b` in order, each kept, removed or added, from their longest common run
/// (removals before additions where both happen).
fn line_ops<'a>(a: &[&'a str], b: &[&'a str]) -> Vec<(Sign, &'a str)> {
    // the same start and end need no table
    let head = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let tail = a[head..].iter().rev().zip(b[head..].iter().rev()).take_while(|(x, y)| x == y).count();
    let (am, bm) = (&a[head..a.len() - tail], &b[head..b.len() - tail]);
    let mut ops: Vec<(Sign, &str)> = a[..head].iter().map(|l| (Sign::Same, *l)).collect();
    let (n, m) = (am.len(), bm.len());
    // checked, since on wasm32 a usize product of two large edits can wrap past the limit
    if n.checked_mul(m).is_none_or(|cells| cells > MAX_CELLS) {
        ops.extend(am.iter().map(|l| (Sign::Del, *l)));
        ops.extend(bm.iter().map(|l| (Sign::Add, *l)));
    } else {
        // lcs[i][j]: the longest common run of am[i..] and bm[j..]
        let w = m + 1;
        let mut lcs = vec![0u32; (n + 1) * w];
        for i in (0..n).rev() {
            for j in (0..m).rev() {
                lcs[i * w + j] = if am[i] == bm[j] { lcs[(i + 1) * w + j + 1] + 1 } else { lcs[(i + 1) * w + j].max(lcs[i * w + j + 1]) };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < n || j < m {
            if i < n && j < m && am[i] == bm[j] {
                ops.push((Sign::Same, am[i]));
                i += 1;
                j += 1;
            } else if i < n && (j == m || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
                ops.push((Sign::Del, am[i]));
                i += 1;
            } else {
                ops.push((Sign::Add, bm[j]));
                j += 1;
            }
        }
    }
    ops.extend(a[a.len() - tail..].iter().map(|l| (Sign::Same, *l)));
    ops
}

/// A tool call's hunks: the ones Claude Code recorded, otherwise each edit's, otherwise a new file's
/// whole text as added lines.
pub fn of_call(patch: Option<&[PatchHunk]>, input: &serde_json::Value) -> Vec<Hunk> {
    if let Some(p) = patch.filter(|p| !p.is_empty()) {
        return p.iter().map(Hunk::from).collect();
    }
    let s = |v: &serde_json::Value, k: &str| v.get(k).and_then(serde_json::Value::as_str).unwrap_or("").to_string();
    if let Some(edits) = input.get("edits").and_then(serde_json::Value::as_array) {
        return edits.iter().flat_map(|e| structured(&s(e, "old_string"), &s(e, "new_string"), CONTEXT)).collect();
    }
    if input.get("old_string").is_some() {
        return structured(&s(input, "old_string"), &s(input, "new_string"), CONTEXT);
    }
    if let Some(content) = input.get("content").and_then(serde_json::Value::as_str) {
        let lines: Vec<String> = split(content).into_iter().map(|l| format!("+{l}")).collect();
        return vec![Hunk { old_start: 0, new_start: 1, lines }];
    }
    vec![]
}

#[cfg(test)]
mod tests {
    use super::*;
    use inyon_protocol::Num;
    use serde_json::json;

    fn line(no: u32, sign: Sign, text: &str) -> Row {
        Row::Line { no, sign, text: text.into() }
    }

    #[test]
    fn a_recorded_patch_is_numbered_from_its_starts() {
        let h = PatchHunk {
            old_start: Num(10.0),
            old_lines: Num(3.0),
            new_start: Num(10.0),
            new_lines: Num(3.0),
            lines: vec![" a".into(), "-b".into(), "+B".into(), "\\ No newline at end of file".into(), " c".into()],
        };
        let hunks = of_call(Some(&[h.clone(), PatchHunk { old_start: Num(40.0), new_start: Num(40.0), ..h }]), &json!({}));
        let d = rows(&hunks, MAX_LINES);
        assert_eq!(d.rows[..4], [line(10, Sign::Same, "a"), line(11, Sign::Del, "b"), line(11, Sign::Add, "B"), line(12, Sign::Same, "c")]);
        assert_eq!(d.rows[4], Row::Gap);
        assert_eq!(d.rows[5], line(40, Sign::Same, "a"));
        assert_eq!(d.hidden, 0);
    }

    #[test]
    fn an_edit_is_compared_line_by_line_with_three_lines_around() {
        let old = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\n20";
        let new = old.replace("\n5\n", "\nfive\n").replace("\n18\n", "\n18\neighteen and a half\n");
        let h = structured(old, &new, CONTEXT);
        assert_eq!(h.len(), 2);
        assert_eq!((h[0].old_start, h[0].new_start), (2, 2));
        assert_eq!(h[0].lines, [" 2", " 3", " 4", "-5", "+five", " 6", " 7", " 8"]);
        assert_eq!((h[1].old_start, h[1].new_start), (16, 16));
        assert_eq!(h[1].lines, [" 16", " 17", " 18", "+eighteen and a half", " 19", " 20", NO_NEWLINE]);
        // changes close together share one hunk
        let near = old.replace("\n5\n", "\nfive\n").replace("\n9\n", "\nnine\n");
        assert_eq!(structured(old, &near, CONTEXT).len(), 1);
    }

    #[test]
    fn edits_new_files_and_nothing() {
        let d = rows(&of_call(None, &json!({ "old_string": "a\nb", "new_string": "a\nc" })), MAX_LINES);
        assert_eq!(d.rows, [line(1, Sign::Same, "a"), line(2, Sign::Del, "b"), line(2, Sign::Add, "c")]);
        let multi = of_call(None, &json!({ "edits": [{ "old_string": "x", "new_string": "y" }, { "old_string": "", "new_string": "z" }] }));
        assert_eq!(multi.len(), 2);
        assert_eq!(multi[1], Hunk { old_start: 0, new_start: 1, lines: vec!["+z".into(), NO_NEWLINE.into()] });
        let d = rows(&of_call(None, &json!({ "content": "one\ntwo" })), MAX_LINES);
        assert_eq!(d.rows, [line(1, Sign::Add, "one"), line(2, Sign::Add, "two")]);
        assert!(of_call(None, &json!({ "command": "ls" })).is_empty());
        assert!(structured("same\n", "same\n", CONTEXT).is_empty());
        // a new file that ends in a newline has no blank last line, and an empty one has no lines
        let d = rows(&of_call(None, &json!({ "content": "one\ntwo\n" })), MAX_LINES);
        assert_eq!(d.rows, [line(1, Sign::Add, "one"), line(2, Sign::Add, "two")]);
        assert!(rows(&of_call(None, &json!({ "content": "" })), MAX_LINES).rows.is_empty());
    }

    #[test]
    fn losing_or_gaining_the_last_newline_is_a_change() {
        let h = structured("a\nsame\n", "a\nsame", CONTEXT);
        assert_eq!(h, [Hunk { old_start: 1, new_start: 1, lines: vec![" a".into(), "-same".into(), "+same".into(), NO_NEWLINE.into()] }]);
        let d = rows(&h, MAX_LINES);
        assert_eq!(d.rows, [line(1, Sign::Same, "a"), line(2, Sign::Del, "same"), line(2, Sign::Add, "same")]);
        let h = structured("x", "x\ny\n", CONTEXT);
        assert_eq!(h[0].lines, ["-x", NO_NEWLINE, "+x", "+y"]);
    }

    #[test]
    fn hunks_past_the_limit_leave_no_gaps_behind() {
        let hunk = |at: u32| Hunk { old_start: at, new_start: at, lines: vec!["-a".into(), "+b".into()] };
        let d = rows(&[hunk(1), hunk(10), hunk(20), hunk(30)], 3);
        assert_eq!(d.rows, [line(1, Sign::Del, "a"), line(1, Sign::Add, "b"), Row::Gap, line(10, Sign::Del, "a")]);
        assert_eq!(d.hidden, 5);
    }

    #[test]
    fn a_long_diff_stops_and_counts_the_rest() {
        let content = (1..=450).map(|i| i.to_string()).collect::<Vec<_>>().join("\n");
        let d = rows(&of_call(None, &json!({ "content": content })), MAX_LINES);
        assert_eq!(d.rows.len(), 400);
        assert_eq!(d.hidden, 50);
        // exactly the limit, newline-terminated, hides nothing
        let content = (1..=400).map(|i| format!("{i}\n")).collect::<String>();
        assert_eq!(rows(&of_call(None, &json!({ "content": content })), MAX_LINES).hidden, 0);
        assert_eq!(d.rows[399], line(400, Sign::Add, "400"));
    }

    #[test]
    fn a_huge_edit_still_shows_every_line() {
        let a = (0..2100).map(|i| format!("a{i}\n")).collect::<String>();
        let b = (0..2100).map(|i| format!("b{i}\n")).collect::<String>();
        let h = structured(&a, &b, CONTEXT);
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].lines.len(), 4200);
        assert!(h[0].lines[0].starts_with('-') && h[0].lines[4199].starts_with('+'));
    }
}
