//! Files from the page: the clipboard, a drop, the file pickers. The composer turns them into
//! attachments (attach.rs) and sends them with upload.rs. Only the browser build has files; other
//! builds get nothing from these yet.

/// What the page saw: a paste, a key, or a file dragged over the message box.
pub enum PageEvent {
    /// `files` and `text` from the clipboard; `in_box` when it landed in the message box itself,
    /// `free` when nothing that takes typing had focus
    Paste {
        files: Vec<File>,
        text: String,
        in_box: bool,
        free: bool,
    },
    /// a printable key with nothing focused that takes typing
    Key,
    /// a drag with files over the box, or leaving it
    Drag(bool),
    Drop(Vec<File>),
}

#[cfg(target_arch = "wasm32")]
pub use imp::*;

#[cfg(target_arch = "wasm32")]
mod imp {
    use wasm_bindgen::closure::Closure;
    use wasm_bindgen::JsCast;

    use super::PageEvent;

    pub type File = web_sys::File;

    pub fn name(f: &File) -> String {
        f.name()
    }

    pub fn size(f: &File) -> f64 {
        f.size()
    }

    pub fn mime(f: &File) -> String {
        f.type_()
    }

    /// A thumbnail for an image, freed with [`revoke`].
    pub fn object_url(f: &File) -> Option<String> {
        web_sys::Url::create_object_url_with_blob(f).ok()
    }

    pub fn revoke(url: &str) {
        let _ = web_sys::Url::revoke_object_url(url);
    }

    /// Text as a file, for a paste too long for the box.
    pub fn text_file(text: &str, name: &str) -> Option<File> {
        let parts = js_sys::Array::of1(&text.into());
        let o = web_sys::FilePropertyBag::new();
        o.set_type("text/plain");
        File::new_with_str_sequence_and_options(&parts, name, &o).ok()
    }

    /// The same bytes under another name.
    pub fn renamed(f: &File, name: &str) -> File {
        let parts = js_sys::Array::of1(f);
        let o = web_sys::FilePropertyBag::new();
        o.set_type(&f.type_());
        File::new_with_blob_sequence_and_options(&parts, name, &o).unwrap_or_else(|_| f.clone())
    }

    /// Opens a hidden file picker.
    pub fn pick(id: &str) {
        if let Some(e) = web_sys::window().and_then(|w| w.document()).and_then(|d| d.get_element_by_id(id)).and_then(|e| e.dyn_into::<web_sys::HtmlElement>().ok()) {
            e.click();
        }
    }

    /// What a file picker holds, emptied so picking the same file again still counts.
    pub fn picked(id: &str) -> Vec<File> {
        let Some(input) = web_sys::window().and_then(|w| w.document()).and_then(|d| d.get_element_by_id(id)).and_then(|e| e.dyn_into::<web_sys::HtmlInputElement>().ok()) else {
            return vec![];
        };
        let out = input.files().map(|l| list(&l)).unwrap_or_default();
        input.set_value("");
        out
    }

    fn list(l: &web_sys::FileList) -> Vec<File> {
        (0..l.length()).filter_map(|i| l.get(i)).collect()
    }

    /// Files on a clipboard or a drop, from whichever field the browser filled (a screenshot is
    /// often only in `items`), named the way the composer sends them.
    fn transfer_files(d: &web_sys::DataTransfer) -> Vec<File> {
        let mut files = d.files().map(|l| list(&l)).unwrap_or_default();
        if files.is_empty() {
            let items = d.items();
            files = (0..items.length()).filter_map(|i| items.get(i)).filter(|it| it.kind() == "file").filter_map(|it| it.get_as_file().ok().flatten()).collect();
        }
        let now = crate::platform::clock().now as u64;
        files
            .into_iter()
            .enumerate()
            .map(|(i, f)| {
                let n = crate::attach::file_name(&f.name(), &f.type_(), now, i);
                if n == f.name() {
                    f
                } else {
                    renamed(&f, &n)
                }
            })
            .collect()
    }

    fn has_files(d: &web_sys::DataTransfer) -> bool {
        let types = d.types();
        (0..types.length()).any(|i| types.get(i).as_string().as_deref() == Some("Files"))
    }

    /// Whether an event's target takes typing itself (a field, the terminal, a sheet).
    fn free(t: Option<web_sys::EventTarget>) -> bool {
        let Some(el) = t.and_then(|t| t.dyn_into::<web_sys::HtmlElement>().ok()) else { return true };
        let tag = el.tag_name();
        !(el.is_content_editable() || matches!(tag.as_str(), "INPUT" | "TEXTAREA" | "SELECT") || el.closest(".xterm, [role=dialog]").ok().flatten().is_some())
    }

    fn in_el(t: Option<web_sys::EventTarget>, id: &str) -> bool {
        t.and_then(|t| t.dyn_into::<web_sys::Element>().ok()).and_then(|e| e.closest(&format!("#{id}")).ok().flatten()).is_some()
    }

    fn is(t: &Option<web_sys::EventTarget>, id: &str) -> bool {
        t.as_ref().and_then(|t| t.dyn_ref::<web_sys::Element>()).is_some_and(|e| e.id() == id)
    }

    type Handler = (&'static str, Closure<dyn Fn(web_sys::Event)>);

    /// Page-wide listeners for the message box; they go when this is dropped.
    pub struct Listener(Vec<Handler>);

    impl Drop for Listener {
        fn drop(&mut self) {
            let Some(d) = web_sys::window().and_then(|w| w.document()) else { return };
            for (kind, f) in &self.0 {
                let _ = d.remove_event_listener_with_callback(kind, f.as_ref().unchecked_ref());
            }
        }
    }

    /// Listens on the page for what the message box takes: pastes (`textbox` is the box's id),
    /// typing with nothing focused, and files dragged onto `zone`. `f` answers true when it took
    /// a paste or a drop, so the browser's own handling is stopped.
    pub fn listen(textbox: &'static str, zone: &'static str, f: impl Fn(PageEvent) -> bool + 'static) -> Option<Listener> {
        let d = web_sys::window()?.document()?;
        let f = std::rc::Rc::new(f);
        let mut all: Vec<Handler> = Vec::new();
        {
            let f = f.clone();
            all.push((
                "paste",
                Closure::new(move |e: web_sys::Event| {
                    let Some(c) = e.dyn_ref::<web_sys::ClipboardEvent>() else { return };
                    let Some(data) = c.clipboard_data() else { return };
                    let t = e.target();
                    let in_box = is(&t, textbox);
                    let ev = PageEvent::Paste { files: transfer_files(&data), text: data.get_data("text/plain").unwrap_or_default(), in_box, free: !in_box && free(t) };
                    if f(ev) {
                        e.prevent_default();
                    }
                }),
            ));
        }
        {
            let f = f.clone();
            all.push((
                "keydown",
                Closure::new(move |e: web_sys::Event| {
                    let Some(k) = e.dyn_ref::<web_sys::KeyboardEvent>() else { return };
                    if e.default_prevented() || k.meta_key() || k.ctrl_key() || k.alt_key() || k.key().chars().count() != 1 || !free(e.target()) {
                        return;
                    }
                    let selected = web_sys::window().and_then(|w| w.get_selection().ok().flatten()).and_then(|s| s.to_string().as_string()).is_some_and(|s| !s.is_empty());
                    if !selected {
                        // the key then types into the box
                        f(PageEvent::Key);
                    }
                }),
            ));
        }
        for kind in ["dragover", "dragleave", "drop"] {
            let f = f.clone();
            all.push((
                kind,
                Closure::new(move |e: web_sys::Event| {
                    let Some(dt) = e.dyn_ref::<web_sys::DragEvent>().and_then(|d| d.data_transfer()) else { return };
                    if !in_el(e.target(), zone) {
                        if kind == "dragleave" || kind == "drop" {
                            f(PageEvent::Drag(false));
                        }
                        return;
                    }
                    match kind {
                        "dragover" if has_files(&dt) => {
                            e.prevent_default();
                            f(PageEvent::Drag(true));
                        }
                        "dragleave" => {
                            f(PageEvent::Drag(false));
                        }
                        "drop" => {
                            e.prevent_default();
                            f(PageEvent::Drag(false));
                            f(PageEvent::Drop(transfer_files(&dt)));
                        }
                        _ => {}
                    }
                }),
            ));
        }
        for (kind, cb) in &all {
            let _ = d.add_event_listener_with_callback(kind, cb.as_ref().unchecked_ref());
        }
        Some(Listener(all))
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub use stub::*;

#[cfg(not(target_arch = "wasm32"))]
#[allow(dead_code)]
mod stub {
    use super::PageEvent;

    /// No files outside the browser build yet; nothing makes one.
    #[derive(Debug, Clone, PartialEq)]
    pub enum File {}

    pub fn name(f: &File) -> String {
        match *f {}
    }
    pub fn size(f: &File) -> f64 {
        match *f {}
    }
    pub fn mime(f: &File) -> String {
        match *f {}
    }
    pub fn object_url(f: &File) -> Option<String> {
        match *f {}
    }
    pub fn revoke(_url: &str) {}
    pub fn text_file(_text: &str, _name: &str) -> Option<File> {
        None
    }
    pub fn pick(_id: &str) {}
    pub fn picked(_id: &str) -> Vec<File> {
        vec![]
    }
    pub struct Listener;
    pub fn listen(_textbox: &'static str, _zone: &'static str, _f: impl Fn(PageEvent) -> bool + 'static) -> Option<Listener> {
        None
    }
}
