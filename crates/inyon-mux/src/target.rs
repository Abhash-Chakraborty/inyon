//! What `-t` names: a pane by id (`%3`), a window by id (`@2`), a session by id (`$1`) or name
//! (`main`), or a place inside one (`main:1`, `main:1.0`, `$1:.%3`).

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// `%3`
    Pane(u32),
    /// `@2`
    Window(u32),
    /// a session, with a window and pane inside it when the target names them
    In { session: Session, window: Option<Part>, pane: Option<Part> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Session {
    /// `$1`
    Id(u32),
    /// `main`; with a leading `=` in the target it must match exactly, which is how the keeper
    /// matches every name
    Name(String),
}

/// A window or pane inside a session: by its id, or by its place in the list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Part {
    Id(u32),
    Index(u32),
}

impl Target {
    pub fn parse(s: &str) -> Result<Target, String> {
        let bad = || format!("can't find {s}");
        if s.is_empty() {
            return Err(bad());
        }
        if let Some(n) = id(s, '%') {
            return Ok(Target::Pane(n));
        }
        if let Some(n) = id(s, '@') {
            return Ok(Target::Window(n));
        }
        let (session, rest) = match s.split_once(':') {
            Some((a, b)) => (a, Some(b)),
            None => (s, None),
        };
        let session = match id(session, '$') {
            Some(n) => Session::Id(n),
            None => {
                let name = session.strip_prefix('=').unwrap_or(session);
                if name.is_empty() {
                    return Err(bad());
                }
                Session::Name(name.to_string())
            }
        };
        let (mut window, mut pane) = (None, None);
        if let Some(rest) = rest {
            let (w, p) = match rest.split_once('.') {
                Some((w, p)) => (w, Some(p)),
                None => (rest, None),
            };
            if !w.is_empty() {
                window = Some(part(w, '@').ok_or_else(bad)?);
            }
            if let Some(p) = p.filter(|p| !p.is_empty()) {
                pane = Some(part(p, '%').ok_or_else(bad)?);
            }
        }
        Ok(Target::In { session, window, pane })
    }
}

fn id(s: &str, mark: char) -> Option<u32> {
    s.strip_prefix(mark).filter(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit())).and_then(|d| d.parse().ok())
}

fn part(s: &str, mark: char) -> Option<Part> {
    id(s, mark).map(Part::Id).or_else(|| s.parse().ok().map(Part::Index))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name(s: &str) -> Session {
        Session::Name(s.to_string())
    }

    #[test]
    fn ids_stand_alone() {
        assert_eq!(Target::parse("%3"), Ok(Target::Pane(3)));
        assert_eq!(Target::parse("@12"), Ok(Target::Window(12)));
        assert_eq!(Target::parse("$1"), Ok(Target::In { session: Session::Id(1), window: None, pane: None }));
    }

    #[test]
    fn a_session_by_name_with_or_without_a_place_in_it() {
        assert_eq!(Target::parse("main"), Ok(Target::In { session: name("main"), window: None, pane: None }));
        assert_eq!(Target::parse("=main"), Ok(Target::In { session: name("main"), window: None, pane: None }));
        assert_eq!(Target::parse("main:1"), Ok(Target::In { session: name("main"), window: Some(Part::Index(1)), pane: None }));
        assert_eq!(Target::parse("main:1.0"), Ok(Target::In { session: name("main"), window: Some(Part::Index(1)), pane: Some(Part::Index(0)) }));
        // the form the hub writes for a pane inside a session
        assert_eq!(Target::parse("$14:.%1"), Ok(Target::In { session: Session::Id(14), window: None, pane: Some(Part::Id(1)) }));
        assert_eq!(Target::parse("$14:@2"), Ok(Target::In { session: Session::Id(14), window: Some(Part::Id(2)), pane: None }));
        // a name may hold dashes, dots stay with the window part
        assert_eq!(Target::parse("inyon-view-578a9a"), Ok(Target::In { session: name("inyon-view-578a9a"), window: None, pane: None }));
    }

    #[test]
    fn what_names_nothing_says_so() {
        assert_eq!(Target::parse(""), Err("can't find ".to_string()));
        assert_eq!(Target::parse(":1"), Err("can't find :1".to_string()));
        assert_eq!(Target::parse("main:x.y"), Err("can't find main:x.y".to_string()));
        // % without digits is a name, as in tmux
        assert_eq!(Target::parse("%"), Ok(Target::In { session: name("%"), window: None, pane: None }));
    }
}
