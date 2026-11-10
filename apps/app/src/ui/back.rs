//! The back button closes what's open on top (lib/back.ts): a picker over a sheet, then the sheet,
//! a menu, Quick access or the selection bar, newest first, and only then goes back a page. Esc
//! closes the same top layer wherever the focus is.
//!
//! Each open layer has an entry of its own in the page's history, at the same address, so the
//! browser's back button, a mouse's back key and Android's back all reach it. A layer that closes
//! some other way (Esc, its backdrop, a pick) leaves its entry behind, spent: the next layer or
//! move to another screen takes its place, and a back that lands on one goes straight past it.
// the page's history is the browser build's and the Android build's; elsewhere only Esc is left
#![cfg_attr(not(any(target_arch = "wasm32", feature = "phone")), allow(dead_code))]

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use dioxus::prelude::*;

/// One entry in the page's history since the first layer opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Entry {
    /// a layer's entry; `open` until the layer closes some way other than back
    Layer { id: u64, open: bool, modal: bool },
    /// a screen moved to while a layer's entry was below it
    Page { id: u64 },
}

impl Entry {
    fn id(&self) -> u64 {
        match self {
            Entry::Layer { id, .. } | Entry::Page { id } => *id,
        }
    }
}

/// What the page's history has to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hist {
    /// a new entry marked with this id
    Push(u64),
    /// this id's mark on the entry the page is at (a spent layer's, taken over)
    Replace(u64),
    /// back this many entries
    Back(u32),
}

/// What a back (a `popstate`) did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Popped {
    /// the layers to close, newest first
    pub close: Vec<u64>,
    /// the address may now be another screen's
    pub route: bool,
    pub then: Option<Hist>,
}

/// The entries above the screen the history started from when the first layer opened, oldest
/// first, as this page put them there. Pure, so it can be tested without a browser.
#[derive(Debug, Default)]
pub struct Stack {
    entries: Vec<Entry>,
    /// backs this page asked for itself, whose `popstate` is no news
    skip: u32,
}

impl Stack {
    /// A layer opened: a new entry, or the spent one at the top taken over.
    pub fn open(&mut self, id: u64, modal: bool) -> Hist {
        if let Some(top @ Entry::Layer { open: false, .. }) = self.entries.last_mut() {
            *top = Entry::Layer { id, open: true, modal };
            return Hist::Replace(id);
        }
        self.entries.push(Entry::Layer { id, open: true, modal });
        Hist::Push(id)
    }

    /// A layer closed some other way than back: its entry stays, spent.
    pub fn shut(&mut self, id: u64) {
        for e in &mut self.entries {
            if let Entry::Layer { id: i, open, .. } = e {
                if *i == id {
                    *open = false;
                }
            }
        }
    }

    /// The app moves to another screen: whether the move replaces the entry the page is at (a spent
    /// layer's), and the mark the new entry carries (none once no layer's entry is left below it).
    pub fn page(&mut self, id: u64) -> (bool, Option<u64>) {
        let spent = matches!(self.entries.last(), Some(Entry::Layer { open: false, .. }));
        if spent {
            self.entries.pop();
        }
        if self.entries.is_empty() {
            return (spent, None);
        }
        self.entries.push(Entry::Page { id });
        (spent, Some(id))
    }

    /// The page went back (or forward) to the entry marked `at` (None: one this page didn't mark).
    pub fn popped(&mut self, at: Option<u64>) -> Popped {
        if self.skip > 0 {
            self.skip -= 1;
            return Popped::default();
        }
        let mut out = Popped::default();
        // forward into an entry this page no longer follows, or a page loaded before this one
        if self.entries.is_empty() || at.is_some_and(|a| !self.entries.iter().any(|e| e.id() == a)) {
            out.route = true;
            return out;
        }
        while let Some(top) = self.entries.last().copied() {
            if Some(top.id()) == at {
                break;
            }
            self.entries.pop();
            match top {
                Entry::Layer { id, open: true, .. } => out.close.push(id),
                Entry::Layer { .. } => {}
                Entry::Page { .. } => out.route = true,
            }
        }
        if out.close.is_empty() && !out.route {
            // only spent entries: the back would show nothing, so it acts on what's below them
            match self.entries.last().copied() {
                Some(Entry::Layer { id, open: true, .. }) => {
                    self.entries.pop();
                    out.close.push(id);
                    self.skip += 1;
                    out.then = Some(Hist::Back(1));
                }
                _ => out.then = Some(Hist::Back(1)),
            }
        }
        out
    }

    /// Back a page from the page menu: past every layer's entry on top, closing what's open.
    pub fn page_back(&mut self) -> (Vec<u64>, Hist) {
        let mut close = vec![];
        let mut n = 0;
        while let Some(Entry::Layer { id, open, .. }) = self.entries.last().copied() {
            self.entries.pop();
            n += 1;
            if open {
                close.push(id);
            }
        }
        (close, Hist::Back(n + 1))
    }

    /// The newest open layer, for Esc: a modal one only, while typing (the selection bar leaves Esc
    /// to the text box or the terminal).
    pub fn top(&self, typing: bool) -> Option<u64> {
        self.entries.iter().rev().find_map(|e| match *e {
            Entry::Layer { id, open: true, modal } if modal || !typing => Some(id),
            _ => None,
        })
    }
}

// ---------- the app's one stack ----------

type Closer = Rc<RefCell<Option<Box<dyn FnMut()>>>>;

thread_local! {
    static STACK: RefCell<Stack> = RefCell::new(Stack::default());
    static CLOSERS: RefCell<HashMap<u64, Closer>> = RefCell::new(HashMap::new());
    /// each [`use_layer`]'s open layer, by the hook's own number
    static SLOTS: RefCell<HashMap<u64, u64>> = RefCell::new(HashMap::new());
    /// marks in this page's history: from the clock, so a reload doesn't reuse an older page's
    static NEXT: Cell<u64> = Cell::new(crate::platform::clock().now as u64);
    /// layers to close, run inside the app (the page's own events arrive outside it)
    static QUEUE: RefCell<Option<futures_channel::mpsc::UnboundedSender<u64>>> = const { RefCell::new(None) };
}

fn next_id() -> u64 {
    NEXT.with(|n| {
        let id = n.get() + 1;
        n.set(id);
        id
    })
}

/// Starts closing the layers back and Esc ask for. Called once, from the shell.
pub fn install() {
    let (tx, mut rx) = futures_channel::mpsc::unbounded::<u64>();
    QUEUE.with(|q| *q.borrow_mut() = Some(tx));
    spawn(async move {
        use futures_util::StreamExt;
        while let Some(id) = rx.next().await {
            let Some(cell) = CLOSERS.with(|c| c.borrow().get(&id).cloned()) else { continue };
            // taken out while it runs, so a redraw that hands the layer a new one can't clash
            let taken = cell.borrow_mut().take();
            if let Some(mut f) = taken {
                f();
                cell.borrow_mut().get_or_insert(f);
            }
        }
    });
}

fn close_later(ids: Vec<u64>) {
    QUEUE.with(|q| {
        if let Some(tx) = q.borrow().as_ref() {
            for id in ids {
                let _ = tx.unbounded_send(id);
            }
        }
    });
}

fn apply(h: Hist) {
    match h {
        Hist::Push(id) => imp::mark(id, false),
        Hist::Replace(id) => imp::mark(id, true),
        Hist::Back(n) => imp::back(n),
    }
}

/// The page went back or forward to an entry marked `at`: closes the layers it went past. True when
/// the address may be another screen's now.
pub fn popped(at: Option<u64>) -> bool {
    let p = STACK.with(|s| s.borrow_mut().popped(at));
    close_later(p.close);
    if let Some(h) = p.then {
        apply(h);
    }
    p.route
}

/// The app moves to another screen: (replace the entry the page is at, the mark for the new one).
pub fn page() -> (bool, Option<u64>) {
    STACK.with(|s| s.borrow_mut().page(next_id()))
}

/// Back a page, past whatever layers are open (the page menu's Back).
pub fn page_back() {
    let (close, h) = STACK.with(|s| s.borrow_mut().page_back());
    close_later(close);
    apply(h);
}

/// Esc: closes the newest open layer, if there is one. True when it did.
pub fn escape(typing: bool) -> bool {
    let Some(id) = STACK.with(|s| s.borrow().top(typing)) else { return false };
    close_later(vec![id]);
    true
}

/// A layer, as [`use_layer`] keeps it while it's open.
#[derive(Clone, Copy)]
pub struct Layer {
    slot: u64,
}

impl Layer {
    fn id(&self) -> Option<u64> {
        SLOTS.with(|s| s.borrow().get(&self.slot).copied())
    }

    /// It closed (a pick, its backdrop): its entry is spent at once, so a move to another screen in
    /// the same click takes the entry's place rather than piling a new one on top.
    pub fn done(&self) {
        if let Some(id) = SLOTS.with(|s| s.borrow_mut().remove(&self.slot)) {
            shut(id);
        }
    }
}

fn shut(id: u64) {
    STACK.with(|s| s.borrow_mut().shut(id));
    CLOSERS.with(|c| c.borrow_mut().remove(&id));
}

/// While `open`, back and Esc close this layer by calling `close`. `modal` for a layer that holds the
/// focus (a sheet, a menu); the selection bar isn't, and leaves Esc to a text box being typed in.
pub fn use_layer(open: bool, modal: bool, close: impl FnMut() + 'static) -> Layer {
    let closer: Closer = use_hook(|| Rc::new(RefCell::new(None)));
    *closer.borrow_mut() = Some(Box::new(close));
    let layer = use_hook(|| Layer { slot: next_id() });
    {
        let closer = closer.clone();
        use_effect(use_reactive!(|open| {
            match (open, layer.id()) {
                (true, None) => {
                    let id = next_id();
                    SLOTS.with(|s| s.borrow_mut().insert(layer.slot, id));
                    CLOSERS.with(|c| c.borrow_mut().insert(id, closer.clone()));
                    let h = STACK.with(|s| s.borrow_mut().open(id, modal));
                    apply(h);
                }
                (false, Some(_)) => layer.done(),
                _ => {}
            }
        }));
    }
    use_drop(move || layer.done());
    layer
}

#[cfg(target_arch = "wasm32")]
mod imp {
    use wasm_bindgen::JsValue;

    const KEY: &str = "inyonLayer";

    /// The mark an entry carries, as a history state.
    pub fn state(id: Option<u64>) -> JsValue {
        let Some(id) = id else { return JsValue::NULL };
        let o = js_sys::Object::new();
        let _ = js_sys::Reflect::set(&o, &KEY.into(), &(id as f64).into());
        o.into()
    }

    /// The mark on the entry the page is at.
    pub fn current() -> Option<u64> {
        let st = web_sys::window()?.history().ok()?.state().ok()?;
        js_sys::Reflect::get(&st, &KEY.into()).ok()?.as_f64().map(|v| v as u64)
    }

    pub fn mark(id: u64, replace: bool) {
        let Some(h) = web_sys::window().and_then(|w| w.history().ok()) else { return };
        let st = state(Some(id));
        let _ = if replace { h.replace_state(&st, "") } else { h.push_state(&st, "") };
    }

    pub fn back(n: u32) {
        if let Some(h) = web_sys::window().and_then(|w| w.history().ok()) {
            let _ = h.go_with_delta(-(n as i32));
        }
    }
}

/// The Android build's page, by script: Rust runs outside it there.
#[cfg(all(not(target_arch = "wasm32"), feature = "phone"))]
mod imp {
    fn mark_js(id: u64, replace: bool) -> String {
        format!("history.{}({{inyonLayer: {id}}}, '')", if replace { "replaceState" } else { "pushState" })
    }

    pub fn mark(id: u64, replace: bool) {
        let _ = dioxus::document::eval(&mark_js(id, replace));
    }

    pub fn back(n: u32) {
        let _ = dioxus::document::eval(&format!("history.go(-{n})"));
    }
}

#[cfg(all(not(target_arch = "wasm32"), not(feature = "phone")))]
mod imp {
    pub fn mark(_id: u64, _replace: bool) {}
    pub fn back(_n: u32) {}
}

#[cfg(target_arch = "wasm32")]
pub use imp::{current, state};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn back_closes_the_newest_layer_first_then_goes_back_a_page() {
        let mut s = Stack::default();
        // a sheet, then a picker over it
        assert_eq!(s.open(1, true), Hist::Push(1));
        assert_eq!(s.open(2, true), Hist::Push(2));
        assert_eq!(s.popped(Some(1)), Popped { close: vec![2], route: false, then: None });
        assert_eq!(s.popped(None), Popped { close: vec![1], route: false, then: None });
        // nothing open: back is the screen's
        assert_eq!(s.popped(None), Popped { close: vec![], route: true, then: None });
    }

    #[test]
    fn a_layer_closed_some_other_way_leaves_a_spent_entry_the_next_one_takes() {
        let mut s = Stack::default();
        s.open(1, true);
        s.shut(1);
        // the next menu takes the spent entry over instead of adding one
        assert_eq!(s.open(2, true), Hist::Replace(2));
        s.shut(2);
        // a move to another screen does too, and leaves nothing to follow
        assert_eq!(s.page(3), (true, None));
        assert_eq!(s.popped(None), Popped { close: vec![], route: true, then: None });
    }

    #[test]
    fn a_back_onto_a_spent_entry_goes_straight_past_it() {
        let mut s = Stack::default();
        s.open(1, true);
        s.shut(1);
        // Esc closed the menu: back lands on its spent entry and goes on to the screen before
        assert_eq!(s.popped(None), Popped { close: vec![], route: false, then: Some(Hist::Back(1)) });
        assert_eq!(s.popped(None), Popped { close: vec![], route: true, then: None });
        // a spent menu over an open sheet: one back closes the sheet as well, and its own entry's
        // popstate is no news
        let mut s = Stack::default();
        s.open(1, true);
        s.open(2, true);
        s.shut(2);
        assert_eq!(s.popped(Some(1)), Popped { close: vec![1], route: false, then: Some(Hist::Back(1)) });
        assert_eq!(s.popped(None), Popped::default());
        assert!(s.popped(None).route);
    }

    #[test]
    fn a_screen_moved_to_over_an_open_layer_comes_back_before_the_layer_closes() {
        let mut s = Stack::default();
        // sessions selected, then another screen: the selection's entry stays below it
        s.open(1, false);
        assert_eq!(s.page(2), (false, Some(2)));
        assert_eq!(s.open(3, true), Hist::Push(3));
        assert_eq!(s.popped(Some(2)), Popped { close: vec![3], route: false, then: None });
        assert_eq!(s.popped(Some(1)), Popped { close: vec![], route: true, then: None });
        assert_eq!(s.popped(None), Popped { close: vec![1], route: false, then: None });
    }

    #[test]
    fn forward_into_an_entry_no_longer_followed_is_the_screens() {
        let mut s = Stack::default();
        s.open(1, true);
        s.popped(None);
        assert_eq!(s.popped(Some(1)), Popped { close: vec![], route: true, then: None });
        // a mark from a page loaded before this one
        s.open(5, true);
        assert_eq!(s.popped(Some(99)), Popped { close: vec![], route: true, then: None });
        assert_eq!(s.top(false), Some(5));
    }

    #[test]
    fn the_page_menus_back_goes_past_every_layer_on_top() {
        let mut s = Stack::default();
        s.open(1, false);
        s.page(2);
        s.open(3, true);
        s.shut(3);
        s.open(4, true);
        assert_eq!(s.page_back(), (vec![4], Hist::Back(2)));
        // what's left is the screen moved to, over the selection
        assert_eq!(s.popped(Some(1)), Popped { close: vec![], route: true, then: None });
        assert_eq!(Stack::default().page_back(), (vec![], Hist::Back(1)));
    }

    #[test]
    fn esc_closes_the_newest_open_layer_and_leaves_typing_alone_for_the_selection_bar() {
        let mut s = Stack::default();
        assert_eq!(s.top(false), None);
        s.open(1, false);
        assert_eq!(s.top(false), Some(1));
        assert_eq!(s.top(true), None, "typing in the composer while sessions are selected");
        s.open(2, true);
        assert_eq!(s.top(true), Some(2));
        s.shut(2);
        assert_eq!(s.top(false), Some(1));
    }
}
