//! The Inyon window on Windows, opened from the tray icon: the status at a glance, a pairing
//! code drawn as a picture, and the tray's actions as buttons. It's a window of its own, so no
//! terminal opens or flashes. `inyon window <role> [--pair]` starts it; a second start brings
//! the open one to the front instead. What it does goes to ~/.inyon/node/window.log.

use crate::service::Role;
use crate::ui::dashboard::Status;

#[cfg(not(windows))]
pub fn run(_role: Role, _pair: bool) -> i32 {
    eprintln!("The Inyon window is only on Windows.");
    2
}

#[cfg(windows)]
pub fn run(role: Role, pair: bool) -> i32 {
    win::run(role, pair)
}

/// A line of the status: its text, whether it's the headline (drawn with the dot), and whether
/// the dot is on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub text: String,
    pub headline: bool,
    pub on: bool,
}

/// The lines under the heading: whether it runs, where it answers, which phones are paired.
pub fn summary(s: &Status) -> Vec<Line> {
    let line = |text: String| Line { text, headline: false, on: false };
    let running = s.jobs.iter().any(|j| j.running);
    let set_up = s.jobs.iter().any(|j| j.service);
    let head = match (running, set_up, s.role.as_str()) {
        (true, _, "node") => "Running: your phone can reach this computer",
        (true, _, "joined") => "Running: connected to your hub",
        (true, _, _) => "Running",
        (false, true, _) => "Set up, not running",
        (false, false, _) => "Not set up yet: run inyon setup in a terminal",
    };
    let mut out = vec![Line { text: head.to_string(), headline: true, on: running }];
    if let Some(a) = s.addresses.first().or(s.relays.first()) {
        out.push(line(format!("Answers on {}", crate::http::host_of(a))));
    } else if running {
        out.push(line("No address yet: the tunnel is starting".to_string()));
    }
    if s.phones.is_empty() {
        out.push(line("No phones paired yet".to_string()));
    }
    for p in s.phones.iter().take(3) {
        let seen = p.last_seen.as_deref().map(|t| format!("seen {t}")).unwrap_or_else(|| "never seen".to_string());
        out.push(line(format!("{}  ·  {seen}", p.name)));
    }
    if s.phones.len() > 3 {
        out.push(line(format!("and {} more", s.phones.len() - 3)));
    }
    if s.pairing_open {
        out.push(line("A pairing code is open".to_string()));
    }
    out
}

/// The typed-in code as the app wants it: "ZS5C-3EPG" and "801 356".
pub fn short_code(v: &serde_json::Value) -> Option<(String, String)> {
    let short = v.get("short")?;
    let id = short.get("id").and_then(serde_json::Value::as_str)?;
    let code = short.get("code").and_then(serde_json::Value::as_str)?;
    let (a, b) = id.split_at(id.len().min(4));
    let (c, d) = code.split_at(code.len().min(3));
    Some((format!("{a}-{b}"), format!("{c} {d}")))
}

/// A line in window.log, with the time, for `inyon logs` and support.
pub fn trace(what: &str) {
    use std::io::Write;
    let dir = crate::paths::node_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("window.log")) {
        let _ = writeln!(f, "{} {what}", crate::state::format_time(crate::state::now_ms()));
    }
}

#[cfg(windows)]
mod win {
    use std::cell::RefCell;
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use std::ptr::{null, null_mut};

    use qrcode::{Color, EcLevel, QrCode};
    use serde_json::Value;
    use windows_sys::Win32::Foundation::{GetLastError, COLORREF, ERROR_ALREADY_EXISTS, HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateFontW, CreatePen, CreateSolidBrush, DeleteDC, DeleteObject, DrawTextW, Ellipse, EndPaint, FillRect,
        InvalidateRect, RoundRect, SelectObject, SetBkMode, SetTextColor, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DEFAULT_PITCH, DT_CENTER, DT_END_ELLIPSIS,
        DT_LEFT, DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER, DT_WORDBREAK, FF_DONTCARE, FW_NORMAL, FW_SEMIBOLD, HDC, HFONT, HGDIOBJ, OUT_DEFAULT_PRECIS, PAINTSTRUCT, PS_SOLID,
        SRCCOPY, TRANSPARENT,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Threading::CreateMutexW;
    use windows_sys::Win32::UI::Controls::{DRAWITEMSTRUCT, ODS_SELECTED};
    use windows_sys::Win32::UI::HiDpi::{AdjustWindowRectExForDpi, GetDpiForWindow, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, DrawIconEx, FindWindowW, GetClientRect, GetMessageW, GetSystemMetrics, LoadCursorW, PostMessageW,
        PostQuitMessage, RegisterClassW, SetForegroundWindow, SetWindowPos, ShowWindow, TranslateMessage, BS_OWNERDRAW, CW_USEDEFAULT, DI_NORMAL, IDC_ARROW, MSG, SM_CXSCREEN,
        SM_CYSCREEN, SWP_NOMOVE, SWP_NOZORDER, SW_SHOW, WM_APP, WM_COMMAND, WM_CREATE, WM_DESTROY, WM_DRAWITEM, WM_ERASEBKGND, WM_PAINT, WNDCLASSW, WS_CAPTION, WS_CHILD,
        WS_MINIMIZEBOX, WS_OVERLAPPED, WS_SYSMENU, WS_TABSTOP, WS_VISIBLE,
    };

    use super::{trace, Line};
    use crate::paths;
    use crate::service::{self, Role, Sys};
    use crate::sys::RealProc;
    use crate::ui::dashboard::{gather, Status};

    const CLASS: &str = "InyonWindow";
    /// a fresh status arrived (lparam: Box<Status>)
    const STATUS: u32 = WM_APP + 2;
    /// the engine answered the pairing request (lparam: Box<Value>)
    const PAIRED: u32 = WM_APP + 3;
    /// show a pairing code (a second `--pair` start sends this to the open window)
    const PAIR_NOW: u32 = WM_APP + 4;
    const BTN_PAIR: usize = 1;
    const BTN_LOG: usize = 2;
    const BTN_RESTART: usize = 3;
    const BTN_QUIT: usize = 4;
    const LABELS: [&str; 4] = ["Pair a phone", "Show the log", "Restart", "Quit Inyon"];
    /// CREATE_NO_WINDOW
    const NO_WINDOW: u32 = 0x0800_0000;

    // silver and ink, as COLORREF (0x00BBGGRR)
    const PAPER: COLORREF = 0x00EC_F0F1;
    const CARD: COLORREF = 0x00FF_FFFF;
    const INK: COLORREF = 0x001A_1C1D;
    const INK_PRESSED: COLORREF = 0x0040_4345;
    const MUTED: COLORREF = 0x0066_6A6B;
    const LINE: COLORREF = 0x00D3_D8D9;
    const PRESSED: COLORREF = 0x00E2_E6E8;

    /// logical pixels, scaled by the monitor's DPI
    const WIDTH: i32 = 440;
    const PAD: i32 = 28;
    const HEAD_H: i32 = 44;
    const LINE_H: i32 = 24;
    const CARD_PAD: i32 = 18;
    const QR: i32 = 196;
    const BTN_H: i32 = 36;
    const GAP: i32 = 10;

    struct State {
        role: Role,
        lines: Vec<Line>,
        pairing: Option<Value>,
        pairing_busy: bool,
        dpi: i32,
        title: HFONT,
        body: HFONT,
        small: HFONT,
        mono: HFONT,
        buttons: [HWND; 4],
    }

    thread_local! {
        static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn me() -> std::path::PathBuf {
        std::env::current_exe().unwrap_or_else(|_| paths::installed_binary())
    }

    fn font(dpi: i32, pt: i32, weight: i32, face: &str) -> HFONT {
        let height = -(pt * dpi) / 72;
        unsafe {
            CreateFontW(
                height,
                0,
                0,
                0,
                weight,
                0,
                0,
                0,
                DEFAULT_CHARSET as u32,
                OUT_DEFAULT_PRECIS as u32,
                CLIP_DEFAULT_PRECIS as u32,
                CLEARTYPE_QUALITY as u32,
                (DEFAULT_PITCH | FF_DONTCARE) as u32,
                wide(face).as_ptr(),
            )
        }
    }

    pub fn run(role: Role, pair: bool) -> i32 {
        trace(&format!("start {role}{}", if pair { " --pair" } else { "" }));
        unsafe {
            SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            // one window per job: a second start brings the first to the front
            let mutex = CreateMutexW(null(), 0, wide(&format!("Local\\InyonWindow-{}", role.name())).as_ptr());
            if !mutex.is_null() && GetLastError() == ERROR_ALREADY_EXISTS {
                let open = FindWindowW(wide(CLASS).as_ptr(), null());
                trace(&format!("another window is open ({}); handing over", if open.is_null() { "not found" } else { "found" }));
                if !open.is_null() {
                    ShowWindow(open, SW_SHOW);
                    SetForegroundWindow(open);
                    if pair {
                        PostMessageW(open, PAIR_NOW, 0, 0);
                    }
                }
                return 0;
            }
            let instance = GetModuleHandleW(null());
            let class = wide(CLASS);
            let wc = WNDCLASSW {
                lpfnWndProc: Some(proc_),
                hInstance: instance,
                hIcon: crate::tray::win::icon_sized(32, 32),
                hCursor: LoadCursorW(null_mut(), IDC_ARROW),
                lpszClassName: class.as_ptr(),
                ..std::mem::zeroed()
            };
            RegisterClassW(&wc);
            STATE.with(|s| {
                *s.borrow_mut() = Some(State {
                    role,
                    lines: Vec::new(),
                    pairing: None,
                    pairing_busy: false,
                    dpi: 96,
                    title: null_mut(),
                    body: null_mut(),
                    small: null_mut(),
                    mono: null_mut(),
                    buttons: [null_mut(); 4],
                })
            });
            let style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
            let title = wide("Inyon");
            let hwnd = CreateWindowExW(0, class.as_ptr(), title.as_ptr(), style, CW_USEDEFAULT, CW_USEDEFAULT, 10, 10, null_mut(), null_mut(), instance, null());
            if hwnd.is_null() {
                trace(&format!("no window: error {}", GetLastError()));
                return 1;
            }
            fit(hwnd, true);
            ShowWindow(hwnd, SW_SHOW);
            SetForegroundWindow(hwnd);
            trace("shown");
            // the status comes from a thread of its own: it asks Task Scheduler, which takes a moment
            let target = hwnd as usize;
            std::thread::spawn(move || loop {
                let proc = RealProc;
                let sys = Sys::new(&proc);
                let s = gather(&sys, false);
                if PostMessageW(target as HWND, STATUS, 0, Box::into_raw(Box::new(s)) as LPARAM) == 0 {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_secs(2));
            });
            if pair {
                PostMessageW(hwnd, PAIR_NOW, 0, 0);
            }
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            trace("closed");
            0
        }
    }

    /// The window's content height in logical pixels, from what it shows.
    fn content_height(lines: usize, has_qr: bool, busy: bool) -> i32 {
        let mut h = PAD + HEAD_H + 20;
        // the status card
        h += CARD_PAD + lines.max(1) as i32 * LINE_H + CARD_PAD;
        if has_qr {
            h += GAP + CARD_PAD + QR + CARD_PAD;
        } else if busy {
            h += GAP + LINE_H;
        }
        h + 20 + BTN_H + PAD
    }

    /// Sizes the window to its content and places the buttons; centred on the first showing.
    fn fit(hwnd: HWND, centre: bool) {
        unsafe {
            let (k, lines, has_qr, busy, buttons) = STATE.with(|s| {
                let st = s.borrow();
                let st = st.as_ref().unwrap();
                (st.dpi as f32 / 96.0, st.lines.len(), st.pairing.is_some(), st.pairing_busy, st.buttons)
            });
            let px = |v: i32| (v as f32 * k) as i32;
            let h = content_height(lines, has_qr, busy);
            let client = RECT { left: 0, top: 0, right: px(WIDTH), bottom: px(h) };
            let mut outer = client;
            AdjustWindowRectExForDpi(&mut outer, WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX, 0, 0, GetDpiForWindow(hwnd));
            let (w, hh) = (outer.right - outer.left, outer.bottom - outer.top);
            if centre {
                let (sw, sh) = (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
                SetWindowPos(hwnd, null_mut(), (sw - w) / 2, (sh - hh) / 2, w, hh, SWP_NOZORDER);
            } else {
                SetWindowPos(hwnd, null_mut(), 0, 0, w, hh, SWP_NOMOVE | SWP_NOZORDER);
            }
            // the primary button first, the other three after it, across the bottom
            let gap = px(GAP);
            let bw = (px(WIDTH) - 2 * px(PAD) - 3 * gap) / 4;
            let y = px(h - PAD - BTN_H);
            for (i, b) in buttons.iter().enumerate() {
                if !b.is_null() {
                    SetWindowPos(*b, null_mut(), px(PAD) + i as i32 * (bw + gap), y, bw, px(BTN_H), SWP_NOZORDER);
                }
            }
        }
    }

    fn start_pairing(hwnd: HWND) {
        let busy = STATE.with(|s| {
            let mut st = s.borrow_mut();
            let st = st.as_mut().unwrap();
            if st.pairing_busy {
                return true;
            }
            st.pairing_busy = true;
            st.pairing = None;
            false
        });
        if busy {
            return;
        }
        trace("asking the engine for a pairing code");
        fit(hwnd, false);
        unsafe { InvalidateRect(hwnd, null(), 0) };
        let target = hwnd as usize;
        std::thread::spawn(move || {
            let mut answer = None;
            let r = crate::engine::pair(&[], &mut |v| answer = Some(v.clone()));
            let v = match (r, answer) {
                (Ok(()), Some(v)) => v,
                (Ok(()), None) => serde_json::json!({ "error": "The engine gave no code." }),
                (Err(e), _) => serde_json::json!({ "error": e }),
            };
            unsafe { PostMessageW(target as HWND, PAIRED, 0, Box::into_raw(Box::new(v)) as LPARAM) };
        });
    }

    fn act(hwnd: HWND, what: usize) {
        let role = STATE.with(|s| s.borrow().as_ref().map(|st| st.role)).unwrap_or(Role::Link);
        match what {
            BTN_PAIR => start_pairing(hwnd),
            BTN_LOG => {
                trace("opening the log");
                let log = service::log_file(role);
                if let Some(dir) = log.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let _ = std::fs::OpenOptions::new().create(true).append(true).open(&log);
                unsafe {
                    ShellExecuteW(null_mut(), wide("open").as_ptr(), wide(&log.to_string_lossy()).as_ptr(), null(), null(), SW_SHOW);
                }
            }
            BTN_RESTART => {
                trace("restarting");
                std::thread::spawn(move || {
                    let proc = RealProc;
                    let sys = Sys::new(&proc);
                    service::restart_service(&sys, role, &[me().to_string_lossy().into_owned()]);
                });
            }
            BTN_QUIT => {
                trace("quitting the engine");
                // ended as a task, so Task Scheduler doesn't count it as a failure to start again from
                if let Some(task) = service::task_name(role) {
                    let _ = Command::new("schtasks.exe").args(["/End", "/TN", task]).creation_flags(NO_WINDOW).output();
                }
                if let Some(pid) = crate::update::read_running(role).and_then(|r| r.pid) {
                    let proc = RealProc;
                    let sys = Sys::new(&proc);
                    if sys.proc.alive(pid) {
                        sys.proc.signal(pid, crate::sys::Signal::Kill);
                    }
                }
                unsafe { DestroyWindow(hwnd) };
            }
            _ => {}
        }
    }

    unsafe extern "system" fn proc_(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        match msg {
            WM_CREATE => {
                unsafe {
                    let dpi = GetDpiForWindow(hwnd) as i32;
                    let title = font(dpi, 19, FW_SEMIBOLD as i32, "Segoe UI");
                    let body = font(dpi, 10, FW_NORMAL as i32, "Segoe UI");
                    let small = font(dpi, 9, FW_NORMAL as i32, "Segoe UI");
                    let mono = font(dpi, 13, FW_SEMIBOLD as i32, "Consolas");
                    let instance = GetModuleHandleW(null());
                    let mut buttons = [null_mut(); 4];
                    for (i, label) in LABELS.iter().enumerate() {
                        let b = CreateWindowExW(
                            0,
                            wide("BUTTON").as_ptr(),
                            wide(label).as_ptr(),
                            WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW as u32,
                            0,
                            0,
                            10,
                            10,
                            hwnd,
                            (i + 1) as *mut _,
                            instance,
                            null(),
                        );
                        buttons[i] = b;
                    }
                    STATE.with(|s| {
                        if let Some(st) = s.borrow_mut().as_mut() {
                            st.dpi = dpi;
                            st.title = title;
                            st.body = body;
                            st.small = small;
                            st.mono = mono;
                            st.buttons = buttons;
                        }
                    });
                }
                0
            }
            // everything is painted in one go from a buffer, so nothing flickers
            WM_ERASEBKGND => 1,
            WM_COMMAND => {
                act(hwnd, wparam & 0xffff);
                0
            }
            WM_DRAWITEM => {
                // SAFETY: Windows hands an owner-drawn button's item struct with this message
                let item = unsafe { &*(lparam as *const DRAWITEMSTRUCT) };
                draw_button(item);
                1
            }
            STATUS => {
                // SAFETY: the status thread made this box for us and sends each one once
                let status = unsafe { Box::from_raw(lparam as *mut Status) };
                let lines = super::summary(&status);
                let changed = STATE.with(|s| {
                    let mut st = s.borrow_mut();
                    let st = st.as_mut().unwrap();
                    let changed = st.lines != lines;
                    st.lines = lines;
                    changed
                });
                if changed {
                    fit(hwnd, false);
                    unsafe { InvalidateRect(hwnd, null(), 0) };
                }
                0
            }
            PAIRED => {
                // SAFETY: as above, from the pairing thread
                let v = unsafe { Box::from_raw(lparam as *mut Value) };
                trace(&format!("pairing code {}", if v.get("error").is_some() { "failed" } else { "shown" }));
                STATE.with(|s| {
                    if let Some(st) = s.borrow_mut().as_mut() {
                        st.pairing = Some(*v);
                        st.pairing_busy = false;
                    }
                });
                fit(hwnd, false);
                unsafe { InvalidateRect(hwnd, null(), 0) };
                0
            }
            PAIR_NOW => {
                start_pairing(hwnd);
                0
            }
            WM_PAINT => {
                paint(hwnd);
                0
            }
            WM_DESTROY => {
                STATE.with(|s| {
                    if let Some(st) = s.borrow_mut().take() {
                        unsafe {
                            for f in [st.title, st.body, st.small, st.mono] {
                                if !f.is_null() {
                                    DeleteObject(f as HGDIOBJ);
                                }
                            }
                        }
                    }
                });
                unsafe { PostQuitMessage(0) };
                0
            }
            _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
        }
    }

    unsafe fn text(hdc: HDC, font: HFONT, color: COLORREF, s: &str, r: &mut RECT, flags: u32) {
        unsafe {
            SelectObject(hdc, font as HGDIOBJ);
            SetTextColor(hdc, color);
            let mut w = wide(s);
            DrawTextW(hdc, w.as_mut_ptr(), -1, r, flags | DT_NOPREFIX);
        }
    }

    /// A rounded rectangle filled with `fill`, edged with `edge` (the same colour for no edge).
    unsafe fn rounded(hdc: HDC, r: &RECT, radius: i32, fill: COLORREF, edge: COLORREF) {
        unsafe {
            let brush = CreateSolidBrush(fill);
            let pen = CreatePen(PS_SOLID, 1, edge);
            let old_brush = SelectObject(hdc, brush as HGDIOBJ);
            let old_pen = SelectObject(hdc, pen as HGDIOBJ);
            RoundRect(hdc, r.left, r.top, r.right, r.bottom, radius, radius);
            SelectObject(hdc, old_brush);
            SelectObject(hdc, old_pen);
            DeleteObject(brush as HGDIOBJ);
            DeleteObject(pen as HGDIOBJ);
        }
    }

    /// The buttons: the first filled with ink, the others on paper with a hairline, all rounded.
    fn draw_button(item: &DRAWITEMSTRUCT) {
        unsafe {
            let (body, dpi) = STATE.with(|s| s.borrow().as_ref().map(|st| (st.body, st.dpi)).unwrap_or((null_mut(), 96)));
            let hdc = item.hDC;
            let r = item.rcItem;
            let pressed = item.itemState & ODS_SELECTED != 0;
            let primary = item.CtlID as usize == BTN_PAIR;
            // the parent's paper behind the rounded corners
            let paper = CreateSolidBrush(PAPER);
            FillRect(hdc, &r, paper);
            DeleteObject(paper as HGDIOBJ);
            let radius = 8 * dpi / 96;
            let (fill, edge, ink) = match (primary, pressed) {
                (true, false) => (INK, INK, PAPER),
                (true, true) => (INK_PRESSED, INK_PRESSED, PAPER),
                (false, false) => (CARD, LINE, INK),
                (false, true) => (PRESSED, LINE, INK),
            };
            rounded(hdc, &r, radius, fill, edge);
            SetBkMode(hdc, TRANSPARENT as i32);
            let mut rr = r;
            text(hdc, body, ink, LABELS[item.CtlID as usize - 1], &mut rr, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
        }
    }

    fn paint(hwnd: HWND) {
        unsafe {
            let mut ps: PAINTSTRUCT = std::mem::zeroed();
            let screen = BeginPaint(hwnd, &mut ps);
            let mut client: RECT = std::mem::zeroed();
            GetClientRect(hwnd, &mut client);
            let (w, h) = (client.right - client.left, client.bottom - client.top);
            // drawn off screen first, then copied in one go
            let hdc = CreateCompatibleDC(screen);
            let bitmap = CreateCompatibleBitmap(screen, w, h);
            let old = SelectObject(hdc, bitmap as HGDIOBJ);
            let paper = CreateSolidBrush(PAPER);
            FillRect(hdc, &client, paper);
            DeleteObject(paper as HGDIOBJ);
            SetBkMode(hdc, TRANSPARENT as i32);
            STATE.with(|s| {
                let st = s.borrow();
                let Some(st) = st.as_ref() else { return };
                let k = st.dpi as f32 / 96.0;
                let px = |v: i32| (v as f32 * k) as i32;
                let left = px(PAD);
                let right = px(WIDTH - PAD);
                let mut y = px(PAD);
                // the mark, the name, and the version beside it
                let icon = crate::tray::win::icon_sized(px(HEAD_H), px(HEAD_H));
                DrawIconEx(hdc, left, y, icon, px(HEAD_H), px(HEAD_H), 0, null_mut(), DI_NORMAL);
                let tx = left + px(HEAD_H + 14);
                let mut r = RECT { left: tx, top: y, right, bottom: y + px(26) };
                text(hdc, st.title, INK, "Inyon", &mut r, DT_LEFT | DT_SINGLELINE);
                let mut r = RECT { left: tx, top: y + px(26), right, bottom: y + px(HEAD_H) };
                let what = match st.role {
                    Role::Link => "paired with the phone",
                    Role::Node => "on a hub",
                    Role::Hub => "hub",
                };
                text(hdc, st.small, MUTED, &format!("{} · {what}", crate::ui::VERSION), &mut r, DT_LEFT | DT_SINGLELINE);
                y += px(HEAD_H + 20);
                // the status card
                let lines: Vec<Line> = if st.lines.is_empty() { vec![Line { text: "Looking…".to_string(), headline: true, on: false }] } else { st.lines.clone() };
                let card_h = px(CARD_PAD) * 2 + lines.len() as i32 * px(LINE_H);
                let card = RECT { left, top: y, right, bottom: y + card_h };
                rounded(hdc, &card, px(12), CARD, LINE);
                let mut ly = y + px(CARD_PAD);
                for line in &lines {
                    let mut tx = left + px(CARD_PAD);
                    if line.headline {
                        // the dot: filled when it runs, a ring otherwise
                        let d = px(9);
                        let cy = ly + px(LINE_H) / 2;
                        let brush = CreateSolidBrush(if line.on { INK } else { CARD });
                        let pen = CreatePen(PS_SOLID, 1, if line.on { INK } else { MUTED });
                        let ob = SelectObject(hdc, brush as HGDIOBJ);
                        let op = SelectObject(hdc, pen as HGDIOBJ);
                        Ellipse(hdc, tx, cy - d / 2, tx + d, cy + d / 2);
                        SelectObject(hdc, ob);
                        SelectObject(hdc, op);
                        DeleteObject(brush as HGDIOBJ);
                        DeleteObject(pen as HGDIOBJ);
                        tx += d + px(10);
                    }
                    let mut r = RECT { left: tx, top: ly, right: right - px(CARD_PAD), bottom: ly + px(LINE_H) };
                    text(hdc, st.body, if line.headline { INK } else { MUTED }, &line.text, &mut r, DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
                    ly += px(LINE_H);
                }
                y += card_h;
                if let Some(v) = &st.pairing {
                    y += px(GAP);
                    let card = RECT { left, top: y, right, bottom: y + px(CARD_PAD) * 2 + px(QR) };
                    rounded(hdc, &card, px(12), CARD, LINE);
                    let (cx, cy) = (left + px(CARD_PAD), y + px(CARD_PAD));
                    if let Some(err) = v.get("error").and_then(Value::as_str) {
                        let mut r = RECT { left: cx, top: cy, right: right - px(CARD_PAD), bottom: cy + px(QR) };
                        text(hdc, st.body, INK, &format!("Couldn't make a pairing code: {err}"), &mut r, DT_LEFT | DT_WORDBREAK);
                    } else if let Some(code) = v.get("qr").and_then(Value::as_str).and_then(|t| QrCode::with_error_correction_level(t.as_bytes(), EcLevel::L).ok()) {
                        // the code, with a quiet zone of two modules, on the card's white
                        let n = code.width() as i32;
                        let module = (px(QR) / (n + 4)).max(1);
                        let ink = CreateSolidBrush(INK);
                        let (ox, oy) = (cx + 2 * module, cy + (px(QR) - module * n) / 2);
                        for (i, c) in code.to_colors().iter().enumerate() {
                            if *c == Color::Dark {
                                let (x, yy) = ((i as i32) % n, (i as i32) / n);
                                let r = RECT { left: ox + x * module, top: oy + yy * module, right: ox + (x + 1) * module, bottom: oy + (yy + 1) * module };
                                FillRect(hdc, &r, ink);
                            }
                        }
                        DeleteObject(ink as HGDIOBJ);
                        // beside it: how to use it, and the typed-in code
                        let tx = cx + module * (n + 4) + px(16);
                        let mut r = RECT { left: tx, top: cy, right: right - px(CARD_PAD), bottom: cy + px(LINE_H * 3) };
                        text(hdc, st.body, INK, "Scan this in the Inyon app, or with the phone's camera.", &mut r, DT_LEFT | DT_WORDBREAK);
                        let mut r = RECT { left: tx, top: cy + px(LINE_H * 3), right: right - px(CARD_PAD), bottom: cy + px(LINE_H * 4) };
                        text(hdc, st.small, MUTED, "It works once, within 10 minutes.", &mut r, DT_LEFT | DT_WORDBREAK);
                        if let Some((id, pin)) = super::short_code(v) {
                            let base = cy + px(QR) - px(LINE_H * 3) - px(4);
                            let mut r = RECT { left: tx, top: base, right: right - px(CARD_PAD), bottom: base + px(LINE_H) };
                            text(hdc, st.small, MUTED, "Or type a code in the app", &mut r, DT_LEFT | DT_SINGLELINE);
                            let mut r = RECT { left: tx, top: base + px(LINE_H), right: right - px(CARD_PAD), bottom: base + px(LINE_H * 2) };
                            text(hdc, st.mono, INK, &format!("ID    {id}"), &mut r, DT_LEFT | DT_SINGLELINE);
                            let mut r = RECT { left: tx, top: base + px(LINE_H * 2), right: right - px(CARD_PAD), bottom: base + px(LINE_H * 3) };
                            text(hdc, st.mono, INK, &format!("Code  {pin}"), &mut r, DT_LEFT | DT_SINGLELINE);
                        }
                    }
                } else if st.pairing_busy {
                    y += px(GAP);
                    let mut r = RECT { left, top: y, right, bottom: y + px(LINE_H) };
                    text(hdc, st.body, MUTED, "Making a pairing code…", &mut r, DT_LEFT | DT_SINGLELINE | DT_VCENTER);
                }
            });
            BitBlt(screen, 0, 0, w, h, hdc, 0, 0, SRCCOPY);
            SelectObject(hdc, old);
            DeleteObject(bitmap as HGDIOBJ);
            DeleteDC(hdc);
            EndPaint(hwnd, &ps);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::dashboard::{Job, PairedPhone};

    fn status() -> Status {
        Status {
            v: 1,
            cli: "0.17.3".into(),
            engine: Some("0.17.3".into()),
            role: "node".into(),
            hub: None,
            machine: Some("k7m2p9x4".into()),
            jobs: vec![Job { role: "link".into(), service: true, running: true, version: Some("0.17.3".into()) }],
            addresses: vec!["wss://quiet-otter.trycloudflare.com/link".into()],
            relays: vec![],
            phones: vec![PairedPhone { key: "abc".into(), name: "Nothing A142".into(), paired: "2026-10-14".into(), last_seen: Some("22:27".into()) }],
            nodes: None,
            agents: vec![],
            pairing_open: false,
            log: vec![],
            note: None,
        }
    }

    #[test]
    fn the_summary_says_it_runs_where_it_answers_and_who_is_paired() {
        let lines = summary(&status());
        assert_eq!(lines[0], Line { text: "Running: your phone can reach this computer".into(), headline: true, on: true });
        assert_eq!(lines[1].text, "Answers on quiet-otter.trycloudflare.com");
        assert_eq!(lines[2].text, "Nothing A142  ·  seen 22:27");
        assert!(!lines[1].headline);
        let mut s = status();
        s.jobs[0].running = false;
        s.addresses.clear();
        s.phones.clear();
        let lines = summary(&s);
        assert_eq!(lines[0], Line { text: "Set up, not running".into(), headline: true, on: false });
        assert_eq!(lines[1].text, "No phones paired yet");
    }

    #[test]
    fn the_typed_code_is_split_the_way_the_app_shows_it() {
        let v = serde_json::json!({ "short": { "id": "ZS5C3EPG", "code": "801356" } });
        assert_eq!(short_code(&v), Some(("ZS5C-3EPG".to_string(), "801 356".to_string())));
        assert_eq!(short_code(&serde_json::json!({})), None);
    }
}
