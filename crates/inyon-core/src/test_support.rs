//! What the ported tests share: the captures in fixtures/ and the `screen()` splitter.

use std::path::Path;

/// A file under the repo's fixtures/ folder, as text.
pub fn fixture(rel: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures").join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// `s.split('\n')`
pub fn screen(s: &str) -> Vec<String> {
    s.split('\n').map(str::to_owned).collect()
}

/// screenFixture(agent, name): fixtures/screens/<agent>/<name>.txt as lines
pub fn screen_fixture(agent: &str, name: &str) -> Vec<String> {
    screen(&fixture(&format!("screens/{agent}/{name}.txt")))
}

/// `expect(got).toMatchObject(want)`: every field `want` names has the same value in `got`
/// (objects compared by the fields given, arrays element for element).
#[track_caller]
pub fn assert_match(got: &impl serde::Serialize, want: serde_json::Value) {
    let got = serde_json::to_value(got).unwrap();
    if let Some(path) = mismatch("", &got, &want) {
        panic!("{path}\n got: {got}\nwant: {want}");
    }
}

fn mismatch(path: &str, got: &serde_json::Value, want: &serde_json::Value) -> Option<String> {
    use serde_json::Value;
    match (got, want) {
        (Value::Object(g), Value::Object(w)) => w.iter().find_map(|(k, wv)| match g.get(k) {
            Some(gv) => mismatch(&format!("{path}.{k}"), gv, wv),
            None if wv.is_null() => None,
            None => Some(format!("{path}.{k} missing")),
        }),
        (Value::Array(g), Value::Array(w)) if g.len() == w.len() => g.iter().zip(w).enumerate().find_map(|(i, (a, b))| mismatch(&format!("{path}[{i}]"), a, b)),
        _ if got == want => None,
        _ => Some(format!("{path}: {got} ≠ {want}")),
    }
}
