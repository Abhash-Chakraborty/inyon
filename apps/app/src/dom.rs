//! The page operations the screens need beyond what Dioxus does for them: reading and setting a
//! scroll position, focus, the clipboard, the page title. The browser build uses the page; other
//! builds do nothing for now.

#[cfg(target_arch = "wasm32")]
mod imp {
    use wasm_bindgen::closure::Closure;
    use wasm_bindgen::JsCast;

    fn el(id: &str) -> Option<web_sys::HtmlElement> {
        web_sys::window()?.document()?.get_element_by_id(id)?.dyn_into().ok()
    }

    /// `scrollTop`, `scrollHeight` and `clientHeight` of an element.
    pub fn scroll_metrics(id: &str) -> Option<(f64, f64, f64)> {
        let e = el(id)?;
        Some((e.scroll_top() as f64, e.scroll_height() as f64, e.client_height() as f64))
    }

    pub fn set_scroll_top(id: &str, top: f64) {
        if let Some(e) = el(id) {
            e.set_scroll_top(top.round() as i32);
        }
    }

    /// How far down its offset parent an element starts.
    pub fn offset_top(id: &str) -> Option<f64> {
        Some(el(id)?.offset_top() as f64)
    }

    pub fn focus(id: &str) {
        if let Some(e) = el(id) {
            let _ = e.focus();
        }
    }

    pub fn blur(id: &str) {
        if let Some(e) = el(id) {
            let _ = e.blur();
        }
    }

    /// Puts a text box's cursor after its last character.
    pub fn caret_to_end(id: &str) {
        if let Some(t) = el(id).and_then(|e| e.dyn_into::<web_sys::HtmlTextAreaElement>().ok()) {
            let n = t.value().encode_utf16().count() as u32;
            let _ = t.set_selection_range(n, n);
        }
    }

    /// A text box grows with its text up to `max_vh` of the screen, then scrolls.
    pub fn autosize(id: &str, max_vh: f64) {
        let Some(e) = el(id) else { return };
        let max = web_sys::window().and_then(|w| w.inner_height().ok()).and_then(|h| h.as_f64()).unwrap_or(800.0) * max_vh;
        let style = e.style();
        let _ = style.set_property("height", "0px");
        let h = e.scroll_height() as f64;
        let _ = style.set_property("height", &format!("{}px", h.min(max)));
        // phones round line heights, which leaves a 1px overflow and a pointless scrollbar
        let _ = style.set_property("overflow-y", if h > max + 1.0 { "auto" } else { "hidden" });
    }

    /// The window's inner width and height.
    pub fn viewport() -> (f64, f64) {
        let w = web_sys::window();
        let get = |v: Option<Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue>>| v.and_then(|v| v.ok()).and_then(|v| v.as_f64());
        (get(w.as_ref().map(|w| w.inner_width())).unwrap_or(1024.0), get(w.as_ref().map(|w| w.inner_height())).unwrap_or(768.0))
    }

    /// The id of the element that has focus.
    pub fn active_id() -> Option<String> {
        let id = web_sys::window()?.document()?.active_element()?.id();
        (!id.is_empty()).then_some(id)
    }

    /// Whether focus is on something other than the element `id` (and not on nothing, which is
    /// the page's body): a link, a button or a box the reader went to, with or without an id.
    pub fn focus_elsewhere(id: &str) -> bool {
        let Some(doc) = web_sys::window().and_then(|w| w.document()) else { return false };
        let Some(at) = doc.active_element() else { return false };
        let body: Option<web_sys::Element> = doc.body().map(Into::into);
        let nowhere = body.as_ref() == Some(&at) || doc.document_element().as_ref() == Some(&at);
        !nowhere && at.id() != id
    }

    pub fn set_title(t: &str) {
        if let Some(d) = web_sys::window().and_then(|w| w.document()) {
            d.set_title(t);
        }
    }

    /// A phone or tablet: a touch screen as the main pointer.
    pub fn coarse() -> bool {
        web_sys::window().and_then(|w| w.match_media("(pointer: coarse)").ok().flatten()).is_some_and(|m| m.matches())
    }

    /// `navigator.clipboard`, which browsers only offer on HTTPS or localhost: the hub is often
    /// reached over plain HTTP on a private network, where it's undefined.
    fn clipboard() -> Option<web_sys::Clipboard> {
        let w = web_sys::window()?;
        if !w.is_secure_context() {
            return None;
        }
        let c = js_sys::Reflect::get(&w.navigator(), &"clipboard".into()).ok()?;
        (!c.is_undefined() && !c.is_null()).then(|| c.unchecked_into())
    }

    /// Copies text, falling back to a hidden text box and `execCommand` where the page has no
    /// clipboard (lib/clipboard.ts's copyText).
    pub async fn copy(text: &str) -> bool {
        if let Some(c) = clipboard() {
            if wasm_bindgen_futures::JsFuture::from(c.write_text(text)).await.is_ok() {
                return true;
            }
        }
        copy_by_hand(text)
    }

    fn copy_by_hand(text: &str) -> bool {
        let Some(doc) = web_sys::window().and_then(|w| w.document()) else { return false };
        let Some(ta) = doc.create_element("textarea").ok().and_then(|e| e.dyn_into::<web_sys::HtmlTextAreaElement>().ok()) else { return false };
        ta.set_value(text);
        let _ = ta.set_attribute("readonly", "");
        ta.style().set_css_text("position:fixed;top:0;left:0;opacity:0;pointer-events:none");
        let focused = doc.active_element().and_then(|e| e.dyn_into::<web_sys::HtmlElement>().ok());
        let Some(body) = doc.body() else { return false };
        let _ = body.append_child(&ta);
        ta.select();
        let _ = ta.set_selection_range(0, text.encode_utf16().count() as u32);
        let ok = doc.dyn_ref::<web_sys::HtmlDocument>().and_then(|d| d.exec_command("copy").ok()).unwrap_or(false);
        ta.remove();
        if let Some(f) = focused {
            let _ = f.focus();
        }
        ok
    }

    /// The clipboard's text (empty when there's none), or Err when the page can't read it: no
    /// clipboard over plain HTTP, or the browser said no.
    pub async fn paste() -> Result<String, ()> {
        let c = clipboard().ok_or(())?;
        let v = wasm_bindgen_futures::JsFuture::from(c.read_text()).await.map_err(|_| ())?;
        Ok(v.as_string().unwrap_or_default())
    }

    /// The page is on screen (not a background tab or a phone app in the background).
    pub fn visible() -> bool {
        web_sys::window().and_then(|w| w.document()).is_none_or(|d| d.visibility_state() != web_sys::VisibilityState::Hidden)
    }

    /// A short random id (a send's request id, a terminal's).
    pub fn random_id() -> String {
        let n = (js_sys::Math::random() * 2f64.powi(52)) as u64;
        format!("{n:x}")
    }

    /// An element's box on screen: left, top, right, bottom.
    pub fn rect(id: &str) -> Option<(f64, f64, f64, f64)> {
        let r = el(id)?.get_bounding_client_rect();
        Some((r.left(), r.top(), r.right(), r.bottom()))
    }

    /// The width inside the element that holds `id`: the row a panel shares with what's beside it.
    pub fn parent_width(id: &str) -> Option<f64> {
        Some(f64::from(el(id)?.parent_element()?.client_width()))
    }

    /// Sends the pointer's moves and its release to `id` wherever it goes, until it lifts.
    pub fn capture_pointer(id: &str, pointer: i32) {
        if let Some(e) = el(id) {
            let _ = e.set_pointer_capture(pointer);
        }
    }

    /// Marks which ends of a sideways-scrolling row hide more (`data-fade` holds `start` and or
    /// `end`, which the stylesheet fades out), and the first time it's called for the row, lets a
    /// mouse wheel scroll it sideways.
    pub fn strip_edges(strip: &str) {
        let Some(s) = el(strip) else { return };
        let (left, width, shown) = (s.scroll_left(), s.scroll_width(), s.client_width());
        let fade = [(left > 1).then_some("start"), (left + shown < width - 1).then_some("end")].into_iter().flatten().collect::<Vec<_>>().join(" ");
        let _ = s.set_attribute("data-fade", &fade);
        if s.get_attribute("data-wheel").is_none() {
            let _ = s.set_attribute("data-wheel", "");
            let target = s.clone();
            let f = Closure::<dyn Fn(web_sys::Event)>::new(move |e: web_sys::Event| {
                let Some(w) = e.dyn_ref::<web_sys::WheelEvent>() else { return };
                let overflow = target.scroll_width() > target.client_width();
                if overflow && w.delta_y().abs() > w.delta_x().abs() {
                    e.prevent_default();
                    target.set_scroll_left(target.scroll_left() + w.delta_y().round() as i32);
                }
            });
            let opts = web_sys::AddEventListenerOptions::new();
            opts.set_passive(false);
            let _ = s.add_event_listener_with_callback_and_add_event_listener_options("wheel", f.as_ref().unchecked_ref(), &opts);
            f.forget();
        }
    }

    /// Scrolls a sideways row so its child `child` shows whole, clear of the faded ends.
    pub fn strip_show(strip: &str, child: &str) {
        let (Some(s), Some(c)) = (el(strip), el(child)) else { return };
        const PAD: i32 = 28;
        let (left, width) = (c.offset_left(), c.offset_width());
        let (at, shown) = (s.scroll_left(), s.client_width());
        if left - PAD < at {
            s.set_scroll_left((left - PAD).max(0));
        } else if left + width + PAD > at + shown {
            s.set_scroll_left(left + width + PAD - shown);
        }
        strip_edges(strip);
    }

    /// Moves focus into a sheet that just opened: to the element marked `data-autofocus`, or the
    /// sheet itself, unless focus is in it already.
    pub fn focus_into(id: &str) {
        let Some(panel) = el(id) else { return };
        let doc = web_sys::window().and_then(|w| w.document());
        if doc.as_ref().and_then(|d| d.active_element()).is_some_and(|a| panel.contains(Some(&a))) {
            return;
        }
        let target = panel.query_selector("[data-autofocus]").ok().flatten().and_then(|e| e.dyn_into::<web_sys::HtmlElement>().ok());
        let _ = target.unwrap_or(panel).focus();
    }

    const FOCUSABLE: &str = "a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

    /// Tab and Shift+Tab go round inside a sheet: true when focus was moved here, so the key's own
    /// move must not happen.
    pub fn trap_tab(id: &str, back: bool) -> bool {
        let Some(panel) = el(id) else { return false };
        let Ok(list) = panel.query_selector_all(FOCUSABLE) else { return false };
        let all: Vec<web_sys::HtmlElement> = (0..list.length()).filter_map(|i| list.get(i)).filter_map(|n| n.dyn_into().ok()).collect();
        let active = web_sys::window().and_then(|w| w.document()).and_then(|d| d.active_element());
        let (Some(first), Some(last)) = (all.first(), all.last()) else {
            let _ = panel.focus();
            return true;
        };
        let at = |e: &web_sys::HtmlElement| active.as_ref().is_some_and(|a| a == e.unchecked_ref::<web_sys::Element>());
        let inside = active.as_ref().is_some_and(|a| panel.contains(Some(a)));
        let on_panel = active.as_ref().is_some_and(|a| a == panel.unchecked_ref::<web_sys::Element>());
        if !inside || (back && (at(first) || on_panel)) {
            let _ = if back { last.focus() } else { first.focus() };
            return true;
        }
        if !back && at(last) {
            let _ = first.focus();
            return true;
        }
        false
    }

    thread_local! {
        static OPENERS: std::cell::RefCell<Vec<web_sys::HtmlElement>> = const { std::cell::RefCell::new(Vec::new()) };
    }

    /// Remembers what had focus as a sheet opens…
    pub fn push_focus() {
        let el = web_sys::window().and_then(|w| w.document()).and_then(|d| d.active_element()).and_then(|e| e.dyn_into::<web_sys::HtmlElement>().ok());
        if let Some(el) = el {
            OPENERS.with(|o| o.borrow_mut().push(el));
        }
    }

    /// …and hands focus back to it as the sheet closes, if it's still on the page.
    pub fn pop_focus() {
        if let Some(el) = OPENERS.with(|o| o.borrow_mut().pop()) {
            if el.is_connected() {
                let _ = el.focus();
            }
        }
    }

    pub fn open_tab(url: &str) {
        if let Some(w) = web_sys::window() {
            let _ = w.open_with_url_and_target_and_features(url, "_blank", "noopener");
        }
    }

    /// This page's origin ("https://hub.example:4777") and host ("hub.example:4777").
    pub fn origin() -> String {
        web_sys::window().and_then(|w| w.location().origin().ok()).unwrap_or_default()
    }

    pub fn host() -> String {
        web_sys::window().and_then(|w| w.location().host().ok()).unwrap_or_default()
    }

    pub fn user_agent() -> String {
        web_sys::window().and_then(|w| w.navigator().user_agent().ok()).unwrap_or_default()
    }

    /// The browser thinks it has a network.
    pub fn online() -> bool {
        web_sys::window().is_none_or(|w| w.navigator().on_line())
    }

    /// Windows, going by the browser: only a guess at what the machine being added runs.
    pub fn windows() -> bool {
        user_agent().contains("Windows")
    }

    /// The theme on screen: what /theme.js and [`crate::platform::follow_theme`] put on the root.
    pub fn theme() -> &'static str {
        let t = web_sys::window().and_then(|w| w.document()).and_then(|d| d.document_element()).and_then(|r| r.get_attribute("data-theme"));
        if t.as_deref() == Some("dark") {
            "dark"
        } else {
            "light"
        }
    }

    /// The app's stylesheet is in: Dioxus adds it as the app starts, so the first paint can come
    /// before it.
    pub fn styled() -> bool {
        let Some(root) = web_sys::window().and_then(|w| w.document()).and_then(|d| d.document_element()) else { return true };
        web_sys::window().and_then(|w| w.get_computed_style(&root).ok().flatten()).and_then(|s| s.get_property_value("--bg").ok()).is_some_and(|v| !v.trim().is_empty())
    }

    fn post_theme_to(win: &web_sys::Window) {
        let msg = js_sys::Object::new();
        let _ = js_sys::Reflect::set(&msg, &"type".into(), &"theme".into());
        let _ = js_sys::Reflect::set(&msg, &"value".into(), &theme().into());
        let _ = win.post_message(&msg, "*");
    }

    fn page_frames() -> Vec<web_sys::HtmlIFrameElement> {
        let Some(list) = web_sys::window().and_then(|w| w.document()).and_then(|d| d.query_selector_all("iframe.page-frame").ok()) else { return vec![] };
        (0..list.length()).filter_map(|i| list.get(i)).filter_map(|n| n.dyn_into().ok()).collect()
    }

    /// Tells every page frame the app's theme; a page that knows the message follows it.
    pub fn post_theme_all() {
        for f in page_frames() {
            if let Some(w) = f.content_window() {
                post_theme_to(&w);
            }
        }
    }

    /// Tells one page frame the theme, as it loads a new document.
    pub fn post_theme(id: &str) {
        let f = web_sys::window().and_then(|w| w.document()).and_then(|d| d.get_element_by_id(id)).and_then(|e| e.dyn_into::<web_sys::HtmlIFrameElement>().ok());
        if let Some(w) = f.and_then(|f| f.content_window()) {
            post_theme_to(&w);
        }
    }

    /// Whether a message a page sent asks for the theme: `{ type: 'theme?' }` and nothing else
    /// counts (lib/pages.ts's frameMessage).
    pub fn asks_theme(data: &wasm_bindgen::JsValue) -> bool {
        data.is_object() && !js_sys::Array::is_array(data) && js_sys::Reflect::get(data, &"type".into()).ok().and_then(|t| t.as_string()).as_deref() == Some("theme?")
    }

    thread_local! {
        static LISTENING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
        static SLASH: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
        static WAKE: std::cell::RefCell<Vec<Box<dyn Fn()>>> = std::cell::RefCell::new(Vec::new());
        static RESIZE: std::cell::RefCell<Vec<Box<dyn Fn()>>> = std::cell::RefCell::new(Vec::new());
        /// when the page went out of sight (ms since the epoch), until it's back; 0 while shown
        static HIDDEN_AT: std::cell::Cell<f64> = const { std::cell::Cell::new(0.0) };
    }

    /// The page-wide listeners Pages needs, added once: a page frame asking for the theme (answered
    /// only when the message came from that frame's own window, never a frame inside it or another
    /// window), "/" to the filter, coming back into view, and the window's size.
    fn listen() {
        if LISTENING.with(|l| l.replace(true)) {
            return;
        }
        let Some(win) = web_sys::window() else { return };
        let msg = Closure::<dyn Fn(web_sys::MessageEvent)>::new(|e: web_sys::MessageEvent| {
            if !asks_theme(&e.data()) {
                return;
            }
            let Some(src) = e.source() else { return };
            for f in page_frames() {
                if let Some(w) = f.content_window() {
                    if wasm_bindgen::JsValue::from(w.clone()) == wasm_bindgen::JsValue::from(src.clone()) {
                        post_theme_to(&w);
                    }
                }
            }
        });
        let _ = win.add_event_listener_with_callback("message", msg.as_ref().unchecked_ref());
        msg.forget();
        let key = Closure::<dyn Fn(web_sys::KeyboardEvent)>::new(|e: web_sys::KeyboardEvent| {
            if e.key() != "/" || e.meta_key() || e.ctrl_key() || e.alt_key() {
                return;
            }
            let Some(target) = SLASH.with(|s| s.borrow().clone()) else { return };
            let typing = e.target().and_then(|t| t.dyn_into::<web_sys::Element>().ok()).is_some_and(|el| el.closest("input, textarea, [contenteditable]").ok().flatten().is_some());
            if typing {
                return;
            }
            e.prevent_default();
            focus(&target);
        });
        let _ = win.add_event_listener_with_callback("keydown", key.as_ref().unchecked_ref());
        key.forget();
        let wake = Closure::<dyn Fn()>::new(|| {
            if !visible() {
                HIDDEN_AT.with(|h| {
                    if h.get() == 0.0 {
                        h.set(js_sys::Date::now());
                    }
                });
                return;
            }
            WAKE.with(|w| w.borrow().iter().for_each(|f| f()));
            HIDDEN_AT.with(|h| h.set(0.0));
        });
        let _ = win.add_event_listener_with_callback("focus", wake.as_ref().unchecked_ref());
        if let Some(d) = win.document() {
            let _ = d.add_event_listener_with_callback("visibilitychange", wake.as_ref().unchecked_ref());
        }
        wake.forget();
        let resize = Closure::<dyn Fn()>::new(|| RESIZE.with(|r| r.borrow().iter().for_each(|f| f())));
        let _ = win.add_event_listener_with_callback("resize", resize.as_ref().unchecked_ref());
        resize.forget();
    }

    /// Starts answering page frames that ask for the theme.
    pub fn answer_frames() {
        listen();
    }

    /// "/" focuses the element with this id, while one is set (the Pages filter on a wide screen).
    pub fn slash_focuses(id: Option<&str>) {
        listen();
        SLASH.with(|s| *s.borrow_mut() = id.map(str::to_string));
    }

    /// Calls `f` whenever the app comes back into view (window focus, the tab shown again).
    pub fn on_wake(f: impl Fn() + 'static) {
        listen();
        WAKE.with(|w| w.borrow_mut().push(Box::new(f)));
    }

    /// How long the page was out of sight before it came back (ms), for an [`on_wake`] callback;
    /// 0 when it was only the window getting focus again.
    pub fn away_ms() -> f64 {
        let at = HIDDEN_AT.with(std::cell::Cell::get);
        if at == 0.0 {
            0.0
        } else {
            js_sys::Date::now() - at
        }
    }

    /// Calls `f` whenever the window changes size.
    pub fn on_resize(f: impl Fn() + 'static) {
        listen();
        RESIZE.with(|r| r.borrow_mut().push(Box::new(f)));
    }

    /// A Mac, by the browser: ⌘ rather than Ctrl in the shortcuts.
    pub fn mac() -> bool {
        user_agent().contains("Macintosh")
    }

    /// Whether `el` takes typing: a text box, a select, editable text or the terminal.
    fn typing_in(el: Option<web_sys::Element>) -> bool {
        let Some(el) = el else { return false };
        let tag = el.tag_name();
        matches!(tag.as_str(), "INPUT" | "TEXTAREA" | "SELECT")
            || el.dyn_ref::<web_sys::HtmlElement>().is_some_and(|h| h.is_content_editable())
            || el.closest(".xterm").ok().flatten().is_some()
    }

    fn in_terminal(el: Option<&web_sys::Element>) -> bool {
        el.is_some_and(|el| el.closest(".xterm").ok().flatten().is_some())
    }

    /// The app-wide keys (lib/keys.ts in the classic app). `f` gets "p", "shift+p", "o" or "k" for
    /// Ctrl (⌘ on a Mac) with that key, "new" for Alt N (⌥N), "escape" for Esc, and says whether it
    /// took the key.
    /// Ctrl keys leave the terminal alone, where the shell has its own use for them; ⌘ keys work
    /// there too. Alt N works while typing, but not in the terminal; N alone starts a session only
    /// while nothing takes typing and no sheet is open.
    pub fn on_shortcut(f: impl Fn(&str) -> bool + 'static) {
        let Some(win) = web_sys::window() else { return };
        let key = Closure::<dyn Fn(web_sys::KeyboardEvent)>::new(move |e: web_sys::KeyboardEvent| {
            let mac = mac();
            let target = e.target().and_then(|t| t.dyn_into::<web_sys::Element>().ok());
            let focused = web_sys::window().and_then(|w| w.document()).and_then(|d| d.active_element());
            let cmd = if mac { e.meta_key() } else { e.ctrl_key() };
            let other = if mac { e.ctrl_key() } else { e.meta_key() };
            let name = if cmd && !e.alt_key() && !other {
                let name = match (e.key().to_lowercase().as_str(), e.shift_key()) {
                    ("p", false) => "p",
                    ("p", true) => "shift+p",
                    ("o", false) => "o",
                    ("k", false) => "k",
                    ("b", false) => "b",
                    _ => return,
                };
                if !mac && (in_terminal(target.as_ref()) || in_terminal(focused.as_ref())) {
                    return;
                }
                name
            } else if e.alt_key() && !e.meta_key() && !e.ctrl_key() && e.code() == "KeyN" {
                // by `code`: on a Mac ⌥N types a dead key, not "n"
                if in_terminal(target.as_ref()) || in_terminal(focused.as_ref()) {
                    return;
                }
                "new"
            } else if e.key() == "Escape" && !e.meta_key() && !e.ctrl_key() && !e.alt_key() && !e.shift_key() {
                // for a layer that closes on Esc wherever the focus is
                "escape"
            } else if !e.meta_key() && !e.ctrl_key() && !e.alt_key() && e.key().eq_ignore_ascii_case("n") && !e.repeat() {
                let sheet = focused.as_ref().is_some_and(|el| el.closest("[role=dialog], [role=menu]").ok().flatten().is_some());
                if typing_in(target) || typing_in(focused) || sheet {
                    return;
                }
                "new"
            } else {
                return;
            };
            if f(name) {
                e.prevent_default();
                e.stop_propagation();
            }
        });
        let _ = win.add_event_listener_with_callback_and_bool("keydown", key.as_ref().unchecked_ref(), true);
        key.forget();
    }

    // ---------- right-click menus ----------

    thread_local! {
        /// how the last press was made: a long press on a touch screen also sends contextmenu
        static POINTER: std::cell::RefCell<String> = std::cell::RefCell::new("mouse".into());
        /// the text box a menu was opened on, with what was selected in it then (picking an item
        /// moves the focus to the menu)
        static BOX: std::cell::RefCell<Option<(web_sys::HtmlElement, u32, u32, String)>> = const { std::cell::RefCell::new(None) };
    }

    fn follow_pointer() {
        thread_local!(static ON: std::cell::Cell<bool> = const { std::cell::Cell::new(false) });
        if ON.with(|o| o.replace(true)) {
            return;
        }
        let Some(doc) = web_sys::window().and_then(|w| w.document()) else { return };
        let down = Closure::<dyn Fn(web_sys::Event)>::new(|e: web_sys::Event| {
            if let Ok(t) = js_sys::Reflect::get(&e, &"pointerType".into()) {
                POINTER.with(|p| *p.borrow_mut() = t.as_string().unwrap_or_else(|| "mouse".into()));
            }
        });
        let _ = doc.add_event_listener_with_callback_and_bool("pointerdown", down.as_ref().unchecked_ref(), true);
        down.forget();
    }

    /// A box people type text in, as the text box menu takes it (an input of a text type, a
    /// textarea or editable text), and not the terminal's hidden one.
    fn text_box(el: &web_sys::Element) -> Option<web_sys::HtmlElement> {
        let b = el.closest("input, textarea, [contenteditable=''], [contenteditable='true']").ok().flatten()?;
        if b.closest(".xterm").ok().flatten().is_some() {
            return None;
        }
        if let Some(i) = b.dyn_ref::<web_sys::HtmlInputElement>() {
            if !matches!(i.type_().as_str(), "text" | "search" | "url" | "email" | "tel" | "password" | "number" | "") {
                return None;
            }
        }
        b.dyn_into().ok()
    }

    /// The selected text, when the right click at `x`, `y` on `target` is on it or around it.
    fn selection_at(target: &web_sys::Element, x: f64, y: f64) -> String {
        let Some(sel) = web_sys::window().and_then(|w| w.get_selection().ok().flatten()) else { return String::new() };
        let text: String = sel.to_string().into();
        if text.trim().is_empty() || sel.range_count() == 0 {
            return String::new();
        }
        let Ok(r) = sel.get_range_at(0) else { return String::new() };
        let inside = r.common_ancestor_container().is_ok_and(|c| target.contains(Some(&c)));
        let b = r.get_bounding_client_rect();
        let on = x >= b.left() && x <= b.right() && y >= b.top() && y <= b.bottom();
        if inside || on {
            text
        } else {
            String::new()
        }
    }

    /// What a row's right click lands on (ContextMenu.tsx's contextMenu): None when it belongs to
    /// what's under the pointer instead (a text box, a link out, anything marked
    /// `data-native-menu`, all of which get their own menu), or when it was a long press on a touch
    /// screen; else the text selected in the row, which its menu offers to copy first.
    pub fn row_menu(data: &dioxus::prelude::MouseData, x: f64, y: f64) -> Option<String> {
        follow_pointer();
        let Some(e) = data.downcast::<web_sys::MouseEvent>() else { return Some(String::new()) };
        let Some(t) = e.target().and_then(|t| t.dyn_into::<web_sys::Element>().ok()) else { return Some(String::new()) };
        let own = t.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], a[href^='http'], [data-native-menu]").ok().flatten();
        if own.is_some_and(|o| o.closest(".xterm").ok().flatten().is_none()) {
            return None;
        }
        Some(selection_at(&t, x, y))
    }

    /// The last press was a finger's.
    pub fn touch_press() -> bool {
        POINTER.with(|p| p.borrow().as_str() == "touch")
    }

    /// A right click that nothing in the app took (`contextmenu` left without preventDefault): `f`
    /// gets where it was, what it landed on and the text selected, and says whether it opened a
    /// menu. Shift, a finger's long press and anything marked `data-native-menu` keep the
    /// browser's own menu.
    pub fn on_page_menu(f: impl Fn(f64, f64, super::PageAt, String) -> bool + 'static) {
        let Some(win) = web_sys::window() else { return };
        follow_pointer();
        let menu = Closure::<dyn Fn(web_sys::MouseEvent)>::new(move |e: web_sys::MouseEvent| {
            if e.default_prevented() || e.shift_key() || touch_press() {
                return;
            }
            let target = e.target().and_then(|t| t.dyn_into::<web_sys::Element>().ok());
            let Some(el) = target else { return };
            if el.closest("[data-native-menu], iframe, select, .xterm").ok().flatten().is_some() {
                return;
            }
            // the keyboard's menu key gives no position: at the element instead
            let (mut x, mut y) = (e.client_x() as f64, e.client_y() as f64);
            if x == 0.0 && y == 0.0 {
                let r = el.get_bounding_client_rect();
                (x, y) = (r.left() + 12.0, r.top() + r.height().min(24.0));
            }
            let at = if let Some(b) = text_box(&el) {
                let (start, end, picked, editable, secret) = if let Some(i) = b.dyn_ref::<web_sys::HtmlInputElement>() {
                    let (s, e) = (i.selection_start().ok().flatten().unwrap_or(0), i.selection_end().ok().flatten().unwrap_or(0));
                    (s, e, utf16_slice(&i.value(), s, e), !i.read_only() && !i.disabled(), i.type_() == "password")
                } else if let Some(t) = b.dyn_ref::<web_sys::HtmlTextAreaElement>() {
                    let (s, e) = (t.selection_start().ok().flatten().unwrap_or(0), t.selection_end().ok().flatten().unwrap_or(0));
                    (s, e, utf16_slice(&t.value(), s, e), !t.read_only() && !t.disabled(), false)
                } else {
                    let picked = web_sys::window().and_then(|w| w.get_selection().ok().flatten()).map(|s| String::from(s.to_string())).unwrap_or_default();
                    (0, 0, picked, b.is_content_editable(), false)
                };
                let info = super::TextBox { picked: !picked.is_empty(), editable, secret };
                BOX.with(|bx| *bx.borrow_mut() = Some((b, start, end, picked)));
                super::PageAt::TextBox(info)
            } else if let Some(a) = el.closest("a[href]").ok().flatten().and_then(|a| a.dyn_into::<web_sys::HtmlAnchorElement>().ok()) {
                super::PageAt::Link { href: a.href(), path: a.get_attribute("href").unwrap_or_default(), outside: a.origin() != origin() }
            } else {
                super::PageAt::Page
            };
            let picked = if matches!(at, super::PageAt::TextBox(_)) { String::new() } else { selection_at(&el, x, y) };
            if f(x, y, at, picked) {
                e.prevent_default();
            }
        });
        let _ = win.add_event_listener_with_callback("contextmenu", menu.as_ref().unchecked_ref());
        menu.forget();
    }

    /// Part of a JavaScript string by its UTF-16 offsets, as a text box's selection gives them.
    fn utf16_slice(s: &str, start: u32, end: u32) -> String {
        let units: Vec<u16> = s.encode_utf16().collect();
        let (a, b) = ((start as usize).min(units.len()), (end as usize).min(units.len()));
        String::from_utf16_lossy(&units[a.min(b)..b])
    }

    /// Puts the focus and the selection back on the text box the menu was opened on.
    fn restore() -> Option<(web_sys::HtmlElement, u32, u32, String)> {
        let b = BOX.with(|b| b.borrow().clone())?;
        let _ = b.0.focus();
        if let Some(i) = b.0.dyn_ref::<web_sys::HtmlInputElement>() {
            let _ = i.set_selection_range(b.1, b.2);
        } else if let Some(t) = b.0.dyn_ref::<web_sys::HtmlTextAreaElement>() {
            let _ = t.set_selection_range(b.1, b.2);
        }
        Some(b)
    }

    /// Types `text` over the selection: insertText keeps the box's undo history, and the app sees
    /// the change as typing.
    fn insert(text: &str) {
        let Some((el, start, end, _)) = restore() else { return };
        let doc = web_sys::window().and_then(|w| w.document());
        let ok = doc.and_then(|d| d.dyn_into::<web_sys::HtmlDocument>().ok()).and_then(|d| d.exec_command_with_show_ui_and_value("insertText", false, text).ok()).unwrap_or(false);
        let field = el.dyn_ref::<web_sys::HtmlInputElement>().is_some() || el.dyn_ref::<web_sys::HtmlTextAreaElement>().is_some();
        if !ok && field {
            if let Ok(f) = js_sys::Reflect::get(&el, &"setRangeText".into()).and_then(|f| f.dyn_into::<js_sys::Function>()) {
                let args = js_sys::Array::of4(&text.into(), &start.into(), &end.into(), &"end".into());
                let _ = f.apply(&el, &args);
            }
        }
    }

    /// Cut, Copy, Paste or Select all in the text box the menu was opened on. False when the page
    /// may not read the clipboard (Paste), so the keys are the way.
    pub async fn text_op(op: super::TextOp) -> bool {
        let Some((el, _, _, picked)) = BOX.with(|b| b.borrow().clone()) else { return true };
        match op {
            super::TextOp::Cut => {
                if copy(&picked).await {
                    insert("");
                }
            }
            super::TextOp::Copy => {
                copy(&picked).await;
            }
            super::TextOp::Paste => match paste().await {
                Ok(text) => insert(&text),
                Err(()) => {
                    restore();
                    return false;
                }
            },
            super::TextOp::SelectAll => {
                let _ = el.focus();
                if let Some(i) = el.dyn_ref::<web_sys::HtmlInputElement>() {
                    i.select();
                } else if let Some(t) = el.dyn_ref::<web_sys::HtmlTextAreaElement>() {
                    t.select();
                } else if let Some(d) = web_sys::window().and_then(|w| w.document()).and_then(|d| d.dyn_into::<web_sys::HtmlDocument>().ok()) {
                    let _ = d.exec_command("selectAll");
                }
            }
        }
        true
    }

    /// Right-clicks whatever is at `x`, `y` now, so it opens its own menu (a right click elsewhere
    /// while a menu is open, once that menu has closed).
    pub fn context_menu_at(x: f64, y: f64) {
        let Some(doc) = web_sys::window().and_then(|w| w.document()) else { return };
        let Some(el) = doc.element_from_point(x as f32, y as f32) else { return };
        let init = web_sys::MouseEventInit::new();
        init.set_bubbles(true);
        init.set_cancelable(true);
        init.set_client_x(x as i32);
        init.set_client_y(y as i32);
        init.set_button(2);
        if let Ok(e) = web_sys::MouseEvent::new_with_mouse_event_init_dict("contextmenu", &init) {
            let _ = el.dispatch_event(&e);
        }
    }

    /// How many entries the tab's history has (the page menu's Back needs one to go to).
    pub fn history_len() -> u32 {
        web_sys::window().and_then(|w| w.history().ok()).and_then(|h| h.length().ok()).unwrap_or(1)
    }

    /// Whether the focus is in something that takes typing (a text box or the terminal).
    pub fn typing_now() -> bool {
        typing_in(web_sys::window().and_then(|w| w.document()).and_then(|d| d.active_element()))
    }

    /// The part of the window not covered by an on-screen keyboard (the visual viewport): its top
    /// and bottom, the window's width and its full height.
    pub fn visible_area() -> (f64, f64, f64, f64) {
        let (w, h) = viewport();
        let vv = web_sys::window().and_then(|win| js_sys::Reflect::get(&win, &"visualViewport".into()).ok()).filter(|v| v.is_object());
        let num = |k: &str| vv.as_ref().and_then(|v| js_sys::Reflect::get(v, &k.into()).ok()).and_then(|v| v.as_f64());
        // the visual viewport can lag the window's own size by an event
        match (num("offsetTop"), num("height")) {
            (Some(top), Some(height)) => (top, (top + height).min(h), w, h),
            _ => (0.0, h, w, h),
        }
    }

    /// Calls `f` whenever the window or the part of it a keyboard leaves changes.
    pub fn on_viewport(f: impl Fn() + 'static) {
        let f = std::rc::Rc::new(f);
        let g = f.clone();
        on_resize(move || g());
        let Some(vv) = web_sys::window().and_then(|win| js_sys::Reflect::get(&win, &"visualViewport".into()).ok()).filter(|v| v.is_object()) else { return };
        let target: web_sys::EventTarget = vv.unchecked_into();
        let cb = Closure::<dyn Fn()>::new(move || f());
        let _ = target.add_event_listener_with_callback("resize", cb.as_ref().unchecked_ref());
        let _ = target.add_event_listener_with_callback("scroll", cb.as_ref().unchecked_ref());
        cb.forget();
    }

    // ---------- Settings, notices and the intro ----------

    /// The page may use what browsers keep to secure origins (notifications, the service worker).
    pub fn secure() -> bool {
        web_sys::window().is_some_and(|w| w.is_secure_context())
    }

    /// Safari in a tab on an iPhone or iPad (iPadOS says it's a Mac with a touch screen), where
    /// only an app added to the Home Screen gets notifications.
    pub fn home_screen_hint() -> bool {
        let Some(w) = web_sys::window() else { return false };
        let n = w.navigator();
        let ua = n.user_agent().unwrap_or_default();
        let apple = ["iPhone", "iPad", "iPod"].iter().any(|d| ua.contains(d)) || (ua.contains("Macintosh") && n.max_touch_points() > 1);
        let standalone = w.match_media("(display-mode: standalone)").ok().flatten().is_some_and(|m| m.matches())
            || js_sys::Reflect::get(&n, &"standalone".into()).ok().and_then(|v| v.as_bool()) == Some(true);
        apple && !standalone
    }

    fn notification_class() -> Option<js_sys::Function> {
        js_sys::Reflect::get(&js_sys::global(), &"Notification".into()).ok().and_then(|v| v.dyn_into().ok())
    }

    /// What the browser allows for notifications.
    pub fn notice_permission() -> crate::settings::Permission {
        use crate::settings::Permission;
        let Some(n) = notification_class() else { return Permission::Unsupported };
        match js_sys::Reflect::get(&n, &"permission".into()).ok().and_then(|p| p.as_string()).as_deref() {
            Some("granted") => Permission::Granted,
            Some("denied") => Permission::Denied,
            _ => Permission::Default,
        }
    }

    /// Asks the browser for notifications; what it answered.
    pub async fn ask_notices() -> crate::settings::Permission {
        let Some(n) = notification_class() else { return crate::settings::Permission::Unsupported };
        if let Some(f) = js_sys::Reflect::get(&n, &"requestPermission".into()).ok().and_then(|f| f.dyn_into::<js_sys::Function>().ok()) {
            // a promise from today's browsers; only the callback from older Safari
            let mut slot = None;
            let answered = js_sys::Promise::new(&mut |resolve, _| slot = Some(resolve));
            let callback = slot.map(|resolve| {
                Closure::once_into_js(move |_: wasm_bindgen::JsValue| {
                    let _ = resolve.call0(&wasm_bindgen::JsValue::NULL);
                })
            });
            if let Ok(ret) = f.call1(&n, callback.as_ref().unwrap_or(&wasm_bindgen::JsValue::UNDEFINED)) {
                let wait = ret.dyn_into::<js_sys::Promise>().unwrap_or(answered);
                let _ = wasm_bindgen_futures::JsFuture::from(wait).await;
            }
        }
        notice_permission()
    }

    thread_local! {
        /// the notification shown for each tag, so the next one replaces it
        static SHOWN: std::cell::RefCell<std::collections::HashMap<String, wasm_bindgen::JsValue>> = std::cell::RefCell::new(std::collections::HashMap::new());
    }

    /// Takes back the notification shown under `tag`: the page's own, and the one the service
    /// worker showed for a push under the same tag.
    pub fn close_notice(tag: &str) {
        if let Some(n) = SHOWN.with(|s| s.borrow_mut().remove(tag)) {
            call(&n, "close");
        }
        let tag = tag.to_string();
        wasm_bindgen_futures::spawn_local(async move {
            let _ = close_pushed(&tag).await;
        });
    }

    /// Calls `obj[name]()`, when it has one.
    fn call(obj: &wasm_bindgen::JsValue, name: &str) -> Option<wasm_bindgen::JsValue> {
        let f = js_sys::Reflect::get(obj, &name.into()).ok()?.dyn_into::<js_sys::Function>().ok()?;
        f.call0(obj).ok()
    }

    /// Closes the service worker's notifications under `tag` (sw.js shows pushes with the same
    /// tags the page uses).
    async fn close_pushed(tag: &str) -> Option<()> {
        use wasm_bindgen_futures::JsFuture;
        let nav = web_sys::window()?.navigator();
        let workers = js_sys::Reflect::get(&nav, &"serviceWorker".into()).ok().filter(|w| !w.is_undefined())?;
        let reg = JsFuture::from(call(&workers, "getRegistration")?.dyn_into::<js_sys::Promise>().ok()?).await.ok()?;
        if reg.is_undefined() || reg.is_null() {
            return None;
        }
        let get = js_sys::Reflect::get(&reg, &"getNotifications".into()).ok()?.dyn_into::<js_sys::Function>().ok()?;
        let opts = js_sys::Object::new();
        let _ = js_sys::Reflect::set(&opts, &"tag".into(), &tag.into());
        let list = JsFuture::from(get.call1(&reg, &opts).ok()?.dyn_into::<js_sys::Promise>().ok()?).await.ok()?;
        for n in js_sys::Array::from(&list).iter() {
            call(&n, "close");
        }
        Some(())
    }

    /// A notification from the browser itself; clicking it brings the app forward at `href` (a
    /// route inside the app). False when the browser wouldn't show it.
    pub fn show_notice(title: &str, body: &str, tag: &str, href: Option<&str>) -> bool {
        let Some(class) = notification_class() else { return false };
        close_notice(tag);
        let opts = js_sys::Object::new();
        let _ = js_sys::Reflect::set(&opts, &"body".into(), &body.into());
        let _ = js_sys::Reflect::set(&opts, &"tag".into(), &tag.into());
        let _ = js_sys::Reflect::set(&opts, &"icon".into(), &"/icon-192.png".into());
        let _ = js_sys::Reflect::set(&opts, &"badge".into(), &"/badge-96.png".into());
        let args = js_sys::Array::of2(&title.into(), &opts);
        let Ok(n) = js_sys::Reflect::construct(&class, &args) else { return false };
        if let Some(href) = href {
            let (href, tag2) = (href.to_string(), tag.to_string());
            let click = wasm_bindgen::closure::Closure::<dyn FnMut()>::new(move || {
                close_notice(&tag2);
                if let Some(w) = web_sys::window() {
                    let _ = w.focus();
                    crate::route::visit(&href);
                }
            });
            let _ = js_sys::Reflect::set(&n, &"onclick".into(), click.as_ref());
            click.forget();
        }
        SHOWN.with(|s| s.borrow_mut().insert(tag.to_string(), n));
        true
    }

    /// A short buzz on a device that has the Vibration API.
    pub fn vibrate(pattern: &[u32]) {
        let Some(nav) = web_sys::window().map(|w| w.navigator()) else { return };
        let arr = js_sys::Array::new();
        for p in pattern {
            arr.push(&(*p).into());
        }
        if let Some(f) = js_sys::Reflect::get(&nav, &"vibrate".into()).ok().and_then(|f| f.dyn_into::<js_sys::Function>().ok()) {
            let _ = f.call1(&nav, &arr);
        }
    }

    /// A date as this browser writes it ("2/11/2026", "11.2.2026"), in its own locale: naming
    /// `navigator.language` would throw where that isn't a valid tag (a Linux browser under the C
    /// locale says "en-US@posix").
    pub fn local_date(ms: f64) -> String {
        let d = js_sys::Date::new(&ms.into());
        js_sys::Reflect::get(&d, &"toLocaleDateString".into())
            .ok()
            .and_then(|f| f.dyn_into::<js_sys::Function>().ok())
            .and_then(|f| f.call0(&d).ok())
            .and_then(|s| s.as_string())
            .unwrap_or_else(|| d.to_iso_string().as_string().unwrap_or_default().chars().take(10).collect())
    }

    /// Brings the element with this id into view.
    pub fn scroll_to(id: &str) {
        if let Some(el) = web_sys::window().and_then(|w| w.document()).and_then(|d| d.get_element_by_id(id)) {
            el.scroll_into_view();
        }
    }

    /// The address's `#…`, without the `#`.
    pub fn hash() -> String {
        web_sys::window().and_then(|w| w.location().hash().ok()).map(|h| h.trim_start_matches('#').to_string()).unwrap_or_default()
    }

    pub fn reload() {
        if let Some(w) = web_sys::window() {
            let _ = w.location().reload();
        }
    }

    pub fn reduced_motion() -> bool {
        web_sys::window().and_then(|w| w.match_media("(prefers-reduced-motion: reduce)").ok().flatten()).is_some_and(|m| m.matches())
    }

    /// Brings a session's card (its `data-key`, "host pane") into view and puts focus on its
    /// first answer. A card in a folded group isn't on screen, and is passed over.
    pub fn show_card(key: &str) {
        let Some(doc) = web_sys::window().and_then(|w| w.document()) else { return };
        let Ok(list) = doc.query_selector_all("[data-key]") else { return };
        let card = (0..list.length())
            .filter_map(|i| list.item(i)?.dyn_into::<web_sys::Element>().ok())
            .find(|c| c.get_attribute("data-key").as_deref() == Some(key) && c.closest("[inert]").ok().flatten().is_none());
        let Some(card) = card else { return };
        let how = web_sys::ScrollIntoViewOptions::new();
        how.set_block(web_sys::ScrollLogicalPosition::Center);
        how.set_behavior(if reduced_motion() { web_sys::ScrollBehavior::Auto } else { web_sys::ScrollBehavior::Smooth });
        card.scroll_into_view_with_scroll_into_view_options(&how);
        if let Some(b) = card.query_selector("[data-answer]").ok().flatten().and_then(|e| e.dyn_into::<web_sys::HtmlElement>().ok()) {
            let f = web_sys::FocusOptions::new();
            f.set_prevent_scroll(true);
            let _ = b.focus_with_options(&f);
        }
    }

    /// Whether focus is inside an element, or the pointer is over it.
    pub fn holds(id: &str) -> bool {
        let Some(e) = el(id) else { return false };
        let focus = web_sys::window().and_then(|w| w.document()).and_then(|d| d.active_element()).is_some_and(|a| e.contains(Some(&a)));
        focus || e.matches(":hover").unwrap_or(false)
    }

    /// Whether focus is inside an element.
    pub fn focus_inside(id: &str) -> bool {
        let Some(e) = el(id) else { return false };
        web_sys::window().and_then(|w| w.document()).and_then(|d| d.active_element()).is_some_and(|a| e.contains(Some(&a)))
    }

    // ---------- a grid whose items arrive, leave and move (ui/AnimatedList.tsx) ----------

    /// Where each item of a grid was last time (by its `data-key`), measured without transforms
    /// against the grid (which is positioned), and the grid's own width then.
    struct Grid {
        el: web_sys::HtmlElement,
        width: i32,
        at: std::collections::HashMap<String, (i32, i32, i32, i32)>,
    }

    impl Grid {
        fn measure(&self) -> std::collections::HashMap<String, (i32, i32, i32, i32)> {
            let kids = self.el.children();
            (0..kids.length())
                .filter_map(|i| kids.item(i)?.dyn_into::<web_sys::HtmlElement>().ok())
                .filter_map(|c| Some((c.get_attribute("data-key")?, (c.offset_left(), c.offset_top(), c.offset_width(), c.offset_height()))))
                .collect()
        }
    }

    type Watch = (std::rc::Rc<std::cell::RefCell<Grid>>, web_sys::MutationObserver, Closure<dyn FnMut(js_sys::Array, web_sys::MutationObserver)>);

    thread_local! {
        static GRIDS: std::cell::RefCell<Vec<Watch>> = const { std::cell::RefCell::new(Vec::new()) };
    }

    /// A copy of an item that just left, fading out where it was, over the page and out of the
    /// way of everything else; gone after 120 ms.
    fn ghost(grid: &web_sys::HtmlElement, item: &web_sys::HtmlElement, (x, y, w, h): (i32, i32, i32, i32)) {
        let Some(doc) = web_sys::window().and_then(|w| w.document()) else { return };
        let Some(body) = doc.body() else { return };
        let Ok(copy) = item.clone_node_with_deep(true) else { return };
        let Ok(copy) = copy.dyn_into::<web_sys::HtmlElement>() else { return };
        for a in ["id", "data-key", "data-waiting"] {
            let _ = copy.remove_attribute(a);
        }
        if let Ok(inner) = copy.query_selector_all("[id], [data-answer]") {
            for i in 0..inner.length() {
                if let Some(e) = inner.item(i).and_then(|n| n.dyn_into::<web_sys::Element>().ok()) {
                    let _ = e.remove_attribute("id");
                    let _ = e.remove_attribute("data-answer");
                }
            }
        }
        let _ = copy.set_attribute("aria-hidden", "true");
        let _ = copy.set_attribute("inert", "");
        let _ = copy.class_list().add_1("flip-leave");
        let r = grid.get_bounding_client_rect();
        let style = copy.style();
        style.set_css_text(&format!("position:fixed;left:{}px;top:{}px;width:{w}px;height:{h}px;margin:0;z-index:5;pointer-events:none", r.left() + x as f64, r.top() + y as f64));
        let _ = body.append_child(&copy);
        let gone = Closure::once_into_js(move || copy.remove());
        if let Some(w) = web_sys::window() {
            let _ = w.set_timeout_with_callback_and_timeout_and_arguments_0(gone.unchecked_ref(), 120);
        }
    }

    /// Starts an item where it was and lets its transition carry it to where it is now.
    fn slide(item: &web_sys::HtmlElement, dx: i32, dy: i32) {
        let style = item.style();
        let _ = style.set_property("transition", "none");
        let _ = style.set_property("transform", &format!("translate({dx}px, {dy}px)"));
        // the start has to be drawn before the transition can run from it
        let _ = item.offset_width();
        let item = item.clone();
        let go = Closure::once_into_js(move || {
            let style = item.style();
            let _ = style.remove_property("transition");
            let _ = style.remove_property("transform");
        });
        if let Some(w) = web_sys::window() {
            let _ = w.request_animation_frame(go.unchecked_ref());
        }
    }

    /// Watches a grid (by id) so its items move as the web app's AnimatedList moves them: a new
    /// one rises in (the first batch one after another, from the stylesheet), one that goes fades
    /// out where it was, and the others slide to their new places. Each item carries `data-key`.
    /// Nothing moves under reduced motion, or when the grid changed width (that's a reflow).
    pub fn animate_grid(id: &str) {
        let Some(el) = el(id) else { return };
        GRIDS.with(|g| {
            let mut g = g.borrow_mut();
            // a grid that left the page stops being watched before its callback is dropped, so a
            // late mutation can't call into a freed closure
            g.retain(|(grid, observer, _)| {
                let live = grid.borrow().el.is_connected();
                if !live {
                    observer.disconnect();
                }
                live
            });
            if g.iter().any(|(grid, ..)| grid.borrow().el == el) {
                return;
            }
            let grid = Grid { width: el.offset_width(), at: Default::default(), el: el.clone() };
            let at = grid.measure();
            let grid = std::rc::Rc::new(std::cell::RefCell::new(Grid { at, ..grid }));
            let state = grid.clone();
            let cb = Closure::<dyn FnMut(js_sys::Array, web_sys::MutationObserver)>::new(move |records: js_sys::Array, _: web_sys::MutationObserver| {
                let mut st = state.borrow_mut();
                if !st.el.is_connected() {
                    return;
                }
                let next = st.measure();
                let width = st.el.offset_width();
                let still = reduced_motion() || width != st.width || st.el.closest("[inert]").ok().flatten().is_some();
                if !still {
                    for rec in records.iter() {
                        let rec: web_sys::MutationRecord = rec.unchecked_into();
                        let removed = rec.removed_nodes();
                        for i in 0..removed.length() {
                            let Some(item) = removed.item(i).and_then(|n| n.dyn_into::<web_sys::HtmlElement>().ok()) else { continue };
                            // a reorder takes an item out and puts it back: that one didn't leave
                            if item.is_connected() {
                                continue;
                            }
                            let Some(key) = item.get_attribute("data-key") else { continue };
                            if let Some(&was) = st.at.get(&key).filter(|_| !next.contains_key(&key)) {
                                ghost(&st.el, &item, was);
                            }
                        }
                    }
                }
                let kids = st.el.children();
                for i in 0..kids.length() {
                    let Some(item) = kids.item(i).and_then(|c| c.dyn_into::<web_sys::HtmlElement>().ok()) else { continue };
                    let Some(key) = item.get_attribute("data-key") else { continue };
                    let Some(&(x, y, ..)) = st.at.get(&key) else {
                        // a newcomer after the first batch rises at once, wherever it lands
                        let _ = item.style().set_property("animation-delay", "0ms");
                        continue;
                    };
                    // one that was here already doesn't come in again when the list puts it back
                    let _ = item.style().set_property("animation", "none");
                    let (nx, ny, ..) = next[&key];
                    if !still && (x != nx || y != ny) {
                        slide(&item, x - nx, y - ny);
                    }
                }
                st.at = next;
                st.width = width;
            });
            let Ok(observer) = web_sys::MutationObserver::new(cb.as_ref().unchecked_ref()) else { return };
            let opts = web_sys::MutationObserverInit::new();
            opts.set_child_list(true);
            let _ = observer.observe_with_options(&el, &opts);
            g.push((grid, observer, cb));
        });
    }

    /// True the first time it's asked for `key` in this browser tab's session, then false.
    pub fn first_in_session(key: &str) -> bool {
        let Some(s) = web_sys::window().and_then(|w| w.session_storage().ok().flatten()) else { return false };
        if s.get_item(key).ok().flatten().is_some() {
            return false;
        }
        s.set_item(key, "1").is_ok()
    }

    /// A class on the page's root element, on or off.
    pub fn root_class(name: &str, on: bool) {
        if let Some(root) = web_sys::window().and_then(|w| w.document()).and_then(|d| d.document_element()) {
            let list = root.class_list();
            let _ = if on { list.add_1(name) } else { list.remove_1(name) };
        }
    }

    /// Where the element marked `data-intro-target` sits, if one is on screen.
    pub fn intro_target() -> Option<(f64, f64, f64, f64)> {
        let list = web_sys::window()?.document()?.query_selector_all("[data-intro-target]").ok()?;
        (0..list.length())
            .filter_map(|i| list.get(i))
            .filter_map(|n| n.dyn_into::<web_sys::Element>().ok())
            .map(|e| e.get_bounding_client_rect())
            .find(|r| r.width() > 0.0 && r.height() > 0.0)
            .map(|r| (r.left(), r.top(), r.width(), r.height()))
    }

    /// A tab opened at once, before the address it goes to is known: a browser blocks one opened
    /// after a wait (Open in browser mints a link first).
    pub struct PendingTab(Option<web_sys::Window>);

    impl PendingTab {
        pub fn open() -> PendingTab {
            let w = web_sys::window().and_then(|w| w.open_with_url_and_target("", "_blank").ok().flatten());
            if let Some(w) = &w {
                // the page can't reach back into the app
                let _ = js_sys::Reflect::set(w, &"opener".into(), &wasm_bindgen::JsValue::NULL);
            }
            PendingTab(w)
        }

        pub fn go(self, url: &str) {
            match self.0 {
                Some(w) => {
                    let _ = w.location().set_href(url);
                }
                None => open_tab(url),
            }
        }

        pub fn close(self) {
            if let Some(w) = self.0 {
                let _ = w.close();
            }
        }
    }

    /// Calls `f` when the page is hidden or goes away (switching apps, closing the tab, a
    /// reload), while it's held; dropping it takes the listeners off.
    pub struct Leaving(Closure<dyn Fn(web_sys::Event)>);

    impl Drop for Leaving {
        fn drop(&mut self) {
            let Some(w) = web_sys::window() else { return };
            let _ = w.remove_event_listener_with_callback("pagehide", self.0.as_ref().unchecked_ref());
            if let Some(d) = w.document() {
                let _ = d.remove_event_listener_with_callback("visibilitychange", self.0.as_ref().unchecked_ref());
            }
        }
    }

    pub fn on_leave(f: impl Fn() + 'static) -> Option<Leaving> {
        let w = web_sys::window()?;
        let d = w.document()?;
        let cb = Closure::<dyn Fn(web_sys::Event)>::new(move |e: web_sys::Event| {
            let hidden = web_sys::window().and_then(|w| w.document()).is_some_and(|d| d.visibility_state() == web_sys::VisibilityState::Hidden);
            if e.type_() == "pagehide" || hidden {
                f();
            }
        });
        let _ = w.add_event_listener_with_callback("pagehide", cb.as_ref().unchecked_ref());
        let _ = d.add_event_listener_with_callback("visibilitychange", cb.as_ref().unchecked_ref());
        Some(Leaving(cb))
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod imp {
    pub struct Leaving;
    pub fn on_leave(_f: impl Fn() + 'static) -> Option<Leaving> {
        None
    }
    pub fn scroll_metrics(_id: &str) -> Option<(f64, f64, f64)> {
        None
    }
    pub fn set_scroll_top(_id: &str, _top: f64) {}
    pub fn offset_top(_id: &str) -> Option<f64> {
        None
    }
    pub fn focus(_id: &str) {}
    pub fn blur(_id: &str) {}
    pub fn caret_to_end(_id: &str) {}
    pub fn autosize(_id: &str, _max_vh: f64) {}
    pub fn viewport() -> (f64, f64) {
        (1024.0, 768.0)
    }
    pub fn active_id() -> Option<String> {
        None
    }
    pub fn focus_elsewhere(_id: &str) -> bool {
        false
    }
    pub fn set_title(_t: &str) {}
    pub fn coarse() -> bool {
        false
    }
    pub async fn copy(_text: &str) -> bool {
        false
    }
    // the terminal's paste, which only the browser build has
    #[allow(dead_code)]
    pub async fn paste() -> Result<String, ()> {
        Err(())
    }
    pub fn visible() -> bool {
        true
    }
    pub fn random_id() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(1);
        format!("{:x}", N.fetch_add(1, Ordering::Relaxed))
    }
    pub fn rect(_id: &str) -> Option<(f64, f64, f64, f64)> {
        None
    }
    pub fn parent_width(_id: &str) -> Option<f64> {
        None
    }
    pub fn capture_pointer(_id: &str, _pointer: i32) {}
    pub fn strip_edges(_strip: &str) {}
    pub fn strip_show(_strip: &str, _child: &str) {}
    pub fn focus_into(_id: &str) {}
    pub fn trap_tab(_id: &str, _back: bool) -> bool {
        false
    }
    pub fn push_focus() {}
    pub fn pop_focus() {}
    pub fn open_tab(_url: &str) {}
    pub fn origin() -> String {
        String::new()
    }
    pub fn host() -> String {
        String::new()
    }
    pub fn user_agent() -> String {
        String::new()
    }
    pub fn online() -> bool {
        true
    }
    pub fn windows() -> bool {
        false
    }
    pub fn theme() -> &'static str {
        "light"
    }
    pub fn styled() -> bool {
        true
    }
    pub fn post_theme(_id: &str) {}
    pub fn answer_frames() {}
    pub fn slash_focuses(_id: Option<&str>) {}
    pub fn mac() -> bool {
        false
    }
    pub fn on_shortcut(_f: impl Fn(&str) -> bool + 'static) {}
    pub fn on_page_menu(_f: impl Fn(f64, f64, super::PageAt, String) -> bool + 'static) {}
    pub fn row_menu(_data: &dioxus::prelude::MouseData, _x: f64, _y: f64) -> Option<String> {
        Some(String::new())
    }
    pub fn touch_press() -> bool {
        false
    }
    pub async fn text_op(_op: super::TextOp) -> bool {
        true
    }
    pub fn context_menu_at(_x: f64, _y: f64) {}
    pub fn history_len() -> u32 {
        1
    }
    pub fn typing_now() -> bool {
        false
    }
    pub fn visible_area() -> (f64, f64, f64, f64) {
        let (w, h) = viewport();
        (0.0, h, w, h)
    }
    pub fn on_viewport(_f: impl Fn() + 'static) {}
    thread_local! {
        static WAKE: std::cell::RefCell<Vec<Box<dyn Fn()>>> = std::cell::RefCell::new(Vec::new());
        static AWAY: std::cell::Cell<f64> = const { std::cell::Cell::new(0.0) };
    }

    /// Calls `f` whenever the app comes back on screen. The phone app hears it from the platform
    /// (Android: the activity's start); the page's own events don't reach Rust here.
    pub fn on_wake(f: impl Fn() + 'static) {
        #[cfg(all(feature = "phone", not(test)))]
        watch_phone();
        WAKE.with(|w| w.borrow_mut().push(Box::new(f)));
    }

    /// How long the app was out of sight before it came back (ms), for an [`on_wake`] callback.
    pub fn away_ms() -> f64 {
        AWAY.with(std::cell::Cell::get)
    }

    #[cfg_attr(not(feature = "phone"), allow(dead_code))]
    /// The app came back after `away` ms out of sight: runs every [`on_wake`] callback.
    pub fn woke(away: f64) {
        AWAY.with(|a| a.set(away));
        WAKE.with(|w| w.borrow().iter().for_each(|f| f()));
    }

    /// How long the app is out of sight, from the platform's word each time it leaves the screen or
    /// comes back.
    #[cfg_attr(not(feature = "phone"), allow(dead_code))]
    #[derive(Debug, Default)]
    pub struct Away(Option<f64>);

    #[cfg_attr(not(feature = "phone"), allow(dead_code))]
    impl Away {
        /// The app came on screen (`on`) or left it at `now` (ms): how long it was away, when it's back.
        pub fn change(&mut self, on: bool, now: f64) -> Option<f64> {
            if on {
                self.0.take().map(|at| now - at)
            } else {
                self.0.get_or_insert(now);
                None
            }
        }
    }

    /// Follows the phone app on and off screen, once, for the [`on_wake`] callbacks: Android says it
    /// on its own thread, and this runs them on the screens' thread.
    #[cfg(all(feature = "phone", not(test)))]
    fn watch_phone() {
        thread_local!(static ON: std::cell::Cell<bool> = const { std::cell::Cell::new(false) });
        if ON.with(|o| o.replace(true)) {
            return;
        }
        dioxus::core::spawn_forever(async {
            let mut rx = crate::phone::visible();
            let (mut away, start) = (Away::default(), std::time::Instant::now());
            loop {
                let on = *rx.borrow_and_update();
                if let Some(ms) = away.change(on, start.elapsed().as_secs_f64() * 1000.0) {
                    woke(ms);
                }
                if rx.changed().await.is_err() {
                    break;
                }
            }
        });
    }
    pub fn on_resize(_f: impl Fn() + 'static) {}
    pub fn secure() -> bool {
        true
    }
    pub fn home_screen_hint() -> bool {
        false
    }
    pub fn notice_permission() -> crate::settings::Permission {
        crate::settings::Permission::Unsupported
    }
    pub async fn ask_notices() -> crate::settings::Permission {
        crate::settings::Permission::Unsupported
    }
    pub fn close_notice(_tag: &str) {}
    pub fn show_notice(_title: &str, _body: &str, _tag: &str, _href: Option<&str>) -> bool {
        false
    }
    pub fn vibrate(_pattern: &[u32]) {}
    /// A date in the phone's time zone, written the one way every locale reads ("2026-11-02").
    pub fn local_date(ms: f64) -> String {
        let t = inyon_chat_core::js::local_time(ms, crate::platform::clock().tz_minutes);
        format!("{}-{:02}-{:02}", t.year, t.month, t.day)
    }
    pub fn scroll_to(_id: &str) {}
    pub fn hash() -> String {
        String::new()
    }
    pub fn reload() {}
    pub fn reduced_motion() -> bool {
        false
    }
    /// The phone app's WebView does the same as the browser build, through the page.
    #[cfg_attr(not(all(feature = "phone", target_os = "android")), allow(unused_variables))]
    pub fn show_card(key: &str) {
        #[cfg(all(feature = "phone", target_os = "android"))]
        {
            let key = serde_json::to_string(key).unwrap_or_default();
            let _ = dioxus::document::eval(&format!(
                "for(const c of document.querySelectorAll('[data-key]')){{if(c.dataset.key!=={key}||c.closest('[inert]'))continue;c.scrollIntoView({{block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'}});const b=c.querySelector('[data-answer]');if(b)b.focus({{preventScroll:true}});break}}"
            ));
        }
    }
    pub fn holds(_id: &str) -> bool {
        false
    }
    pub fn focus_inside(_id: &str) -> bool {
        false
    }
    pub fn animate_grid(_id: &str) {}
    pub fn first_in_session(_key: &str) -> bool {
        false
    }
    pub fn root_class(_name: &str, _on: bool) {}
    pub fn intro_target() -> Option<(f64, f64, f64, f64)> {
        None
    }
    pub struct PendingTab;
    impl PendingTab {
        pub fn open() -> PendingTab {
            PendingTab
        }
        pub fn go(self, _url: &str) {}
        pub fn close(self) {}
    }
}

pub use imp::*;

/// What a right click that nothing in the app took landed on, for the menu it gets.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq)]
pub enum PageAt {
    /// a text box: whether text is selected in it, whether it can be changed, whether it's a password
    TextBox(TextBox),
    /// a link: where it leads in full, as written, and whether that's outside the app's origin
    Link {
        href: String,
        path: String,
        outside: bool,
    },
    Page,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextBox {
    pub picked: bool,
    pub editable: bool,
    pub secret: bool,
}

/// What the text box menu does to the box it was opened on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextOp {
    Cut,
    Copy,
    Paste,
    SelectAll,
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    #[test]
    fn the_app_coming_back_says_how_long_it_was_away() {
        let mut a = super::Away::default();
        assert_eq!(a.change(true, 10.0), None);
        assert_eq!(a.change(false, 1_000.0), None);
        // leaving twice counts from the first time
        assert_eq!(a.change(false, 2_000.0), None);
        assert_eq!(a.change(true, 361_000.0), Some(360_000.0));
        assert_eq!(a.change(true, 362_000.0), None);
    }

    #[test]
    fn coming_back_runs_the_wake_callbacks_with_the_time_away() {
        use std::cell::Cell;
        use std::rc::Rc;
        let seen = Rc::new(Cell::new(0.0));
        let s = seen.clone();
        super::on_wake(move || s.set(super::away_ms()));
        super::woke(400_000.0);
        assert_eq!(seen.get(), 400_000.0);
    }

    #[test]
    fn a_date_off_the_browser_is_a_calendar_date() {
        // 2 November 2026, 18:00 UTC
        assert_eq!(super::local_date(1_793_642_400_000.0), "2026-11-02");
    }
}
