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
    if let Some(a) = s.answering().first() {
        out.push(line(format!("Answers on {}", crate::http::host_of(a))));
    } else if s.link_running() {
        out.push(line("No address yet: the tunnel is starting".to_string()));
    }
    if s.reach.is_some() {
        out.push(line("Tunnel only: inyon doctor says how to allow the same Wi-Fi or VPN".to_string()));
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

/// What the code card shows for one of the engine's answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodeCard {
    /// it couldn't make one
    Failed(String),
    /// no code worth scanning yet: the tunnel is starting
    Starting(&'static str),
    /// the QR code and the typed-in code, with a note while the tunnel still starts
    Code { note: &'static str },
}

pub fn code_card(v: &serde_json::Value) -> CodeCard {
    use inyon_engine::output::{TUNNEL_SLOW, TUNNEL_STARTING};
    if let Some(e) = v.get("error").and_then(serde_json::Value::as_str) {
        return CodeCard::Failed(e.to_string());
    }
    let waiting = v.get("waiting").is_some();
    let none = |k: &str| v.get(k).and_then(serde_json::Value::as_array).is_none_or(|a| a.is_empty());
    match (waiting, v.get("qr").is_some(), none("urls") && none("relays")) {
        (true, false, _) => CodeCard::Starting(TUNNEL_STARTING),
        (true, true, true) => CodeCard::Starting(TUNNEL_SLOW),
        (true, true, false) => CodeCard::Code { note: "The tunnel is still starting: until it's up, this works on the same network or VPN." },
        _ => CodeCard::Code { note: "It works once, within 10 minutes." },
    }
}

/// What the window shows when the pairing's engine ends, given how it ended and whether the last
/// answer shown was only "the tunnel is starting" (None: nothing was shown). A usable code stays
/// on screen; a card still waiting for the tunnel is replaced by why it never came.
pub fn pairing_ended(r: Result<(), String>, last_starting: Option<bool>) -> Option<String> {
    match (r, last_starting) {
        (Err(e), None | Some(true)) => Some(e),
        (Ok(()), None) => Some("The engine gave no code.".to_string()),
        (Ok(()), Some(true)) => Some("The engine stopped before the tunnel came up. `inyon logs` shows what it said.".to_string()),
        (_, Some(false)) => None,
    }
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

/// A line in window.log, with the time, for `inyon logs` and support; on stderr too, for a run
/// from a terminal.
pub fn trace(what: &str) {
    use std::io::Write;
    eprintln!("window: {what}");
    let dir = crate::paths::node_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("window.log")) {
        let _ = writeln!(f, "{} {what}", crate::state::format_time(crate::state::now_ms()));
    }
}

#[cfg(windows)]
mod win {
    use std::cell::RefCell;
    use std::ptr::{null, null_mut};

    use qrcode::{Color, EcLevel, QrCode};
    use serde_json::Value;
    use windows_sys::Win32::Foundation::{GetLastError, COLORREF, ERROR_ALREADY_EXISTS, HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateFontW, CreateSolidBrush, DeleteDC, DeleteObject, DrawTextW, EndPaint, FillRect, InvalidateRect,
        SelectObject, SetBkMode, SetTextColor, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DEFAULT_PITCH, DT_CALCRECT, DT_CENTER, DT_END_ELLIPSIS, DT_LEFT,
        DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER, DT_WORDBREAK, FF_DONTCARE, FW_NORMAL, FW_SEMIBOLD, HDC, HFONT, HGDIOBJ, OUT_DEFAULT_PRECIS, PAINTSTRUCT, SRCCOPY, TRANSPARENT,
    };
    use windows_sys::Win32::Graphics::GdiPlus::{
        FillModeAlternate, GdipAddPathArcI, GdipClosePathFigure, GdipCreateFromHDC, GdipCreatePath, GdipCreatePen1, GdipCreateSolidFill, GdipDeleteBrush, GdipDeleteGraphics,
        GdipDeletePath, GdipDeletePen, GdipDrawEllipseI, GdipDrawImageRectI, GdipDrawPath, GdipFillEllipseI, GdipFillPath, GdipLoadImageFromStream, GdipSetInterpolationMode,
        GdipSetPixelOffsetMode, GdipSetSmoothingMode, GdiplusStartup, GdiplusStartupInput, GpBrush, GpGraphics, GpImage, GpPath, GpPen, GpSolidFill,
        InterpolationModeHighQualityBicubic, PixelOffsetModeHalf, SmoothingModeAntiAlias, UnitPixel,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Threading::CreateMutexW;
    use windows_sys::Win32::UI::Controls::{DRAWITEMSTRUCT, ODS_SELECTED};
    use windows_sys::Win32::UI::HiDpi::{AdjustWindowRectExForDpi, GetDpiForWindow, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
    use windows_sys::Win32::UI::Shell::{SHCreateMemStream, ShellExecuteW};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, FindWindowW, GetClientRect, GetMessageW, GetSystemMetrics, LoadCursorW, PostMessageW, PostQuitMessage,
        RegisterClassW, SetForegroundWindow, SetWindowPos, ShowWindow, TranslateMessage, BS_OWNERDRAW, CW_USEDEFAULT, IDC_ARROW, MSG, SM_CXSCREEN, SM_CYSCREEN, SWP_NOMOVE,
        SWP_NOZORDER, SW_HIDE, SW_SHOW, WM_APP, WM_COMMAND, WM_CREATE, WM_DESTROY, WM_DRAWITEM, WM_ERASEBKGND, WM_PAINT, WNDCLASSW, WS_CAPTION, WS_CHILD, WS_MINIMIZEBOX,
        WS_OVERLAPPED, WS_SYSMENU, WS_TABSTOP, WS_VISIBLE,
    };

    use super::{trace, Line};
    use crate::paths;
    use crate::service::{self, Role, Sys};
    use crate::sys::RealProc;
    use crate::ui::dashboard::{gather, Status};

    const CLASS: &str = "InyonWindow";
    /// the mark at 512 px, drawn down to size with a smooth filter
    const MARK: &[u8] = include_bytes!("../assets/inyon-512.png");
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

    // silver and ink: text colours as COLORREF (0x00BBGGRR), shapes as ARGB
    const PAPER: COLORREF = 0x00EC_F0F1;
    const INK: COLORREF = 0x001A_1C1D;
    const MUTED: COLORREF = 0x0066_6A6B;
    const A_CARD: u32 = 0xFFFF_FFFF;
    const A_INK: u32 = 0xFF1D_1C1A;
    const A_INK_PRESSED: u32 = 0xFF45_4340;
    const A_MUTED: u32 = 0xFF6B_6A66;
    const A_LINE: u32 = 0xFFD9_D8D3;
    const A_PRESSED: u32 = 0xFFE8_E6E2;

    /// logical pixels, scaled by the monitor's DPI
    const WIDTH: i32 = 500;
    const PAD: i32 = 28;
    const HEAD_H: i32 = 48;
    const LINE_H: i32 = 24;
    const CARD_PAD: i32 = 18;
    const QR: i32 = 188;
    const BTN_H: i32 = 36;
    const GAP: i32 = 10;

    struct State {
        role: Role,
        lines: Vec<Line>,
        pairing: Option<Value>,
        pairing_busy: bool,
        /// a code is shown unasked once, when no phone is paired yet
        offered: bool,
        dpi: i32,
        title: HFONT,
        body: HFONT,
        small: HFONT,
        mono: HFONT,
        mark: *mut GpImage,
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
            // GDI+ draws the rounded shapes and the mark; GDI draws the text
            let mut token = 0usize;
            let input = GdiplusStartupInput { GdiplusVersion: 1, DebugEventCallback: 0, SuppressBackgroundThread: 0, SuppressExternalCodecs: 0 };
            GdiplusStartup(&mut token, &input, null_mut());
            let mut mark: *mut GpImage = null_mut();
            let stream = SHCreateMemStream(MARK.as_ptr(), MARK.len() as u32);
            if !stream.is_null() {
                GdipLoadImageFromStream(stream, &mut mark);
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
                    offered: pair,
                    dpi: 96,
                    title: null_mut(),
                    body: null_mut(),
                    small: null_mut(),
                    mono: null_mut(),
                    mark,
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
        let post = move |v: Value| {
            let b = Box::into_raw(Box::new(v));
            // SAFETY: the window takes the box with the message; if it's gone, it's ours to free
            unsafe {
                if PostMessageW(target as HWND, PAIRED, 0, b as LPARAM) == 0 {
                    drop(Box::from_raw(b));
                }
            }
        };
        std::thread::spawn(move || {
            // each answer is shown as it comes: the engine stays on when it started the link
            // itself, so it may never return
            let mut last_starting = None;
            let r = crate::engine::pair(&[], &mut |v| {
                last_starting = Some(matches!(super::code_card(v), super::CodeCard::Starting(_)));
                post(v.clone());
            });
            if let Err(e) = &r {
                trace(&format!("the pairing's engine ended: {e}"));
            }
            if let Some(why) = super::pairing_ended(r, last_starting) {
                post(serde_json::json!({ "error": why }));
            }
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
                unsafe { ShowWindow(hwnd, SW_HIDE) };
                // the task, the engine and the tunnel it started, as Restart stops them
                let proc = RealProc;
                let sys = Sys::new(&proc);
                service::quit(&sys, role, crate::update::read_running(role).and_then(|r| r.pid));
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
                    let mono = font(dpi, 12, FW_SEMIBOLD as i32, "Consolas");
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
                let running = status.jobs.iter().any(|j| j.running);
                let (changed, offer) = STATE.with(|s| {
                    let mut st = s.borrow_mut();
                    let st = st.as_mut().unwrap();
                    let changed = st.lines != lines;
                    st.lines = lines;
                    // opened with no phone paired yet: the code is the one thing to do, so show it
                    let offer = !st.offered && running && status.phones.is_empty() && st.pairing.is_none() && !st.pairing_busy;
                    if offer {
                        st.offered = true;
                    }
                    (changed, offer)
                });
                if changed {
                    fit(hwnd, false);
                    unsafe { InvalidateRect(hwnd, null(), 0) };
                }
                if offer {
                    start_pairing(hwnd);
                }
                0
            }
            PAIRED => {
                // SAFETY: as above, from the pairing thread
                let v = unsafe { Box::from_raw(lparam as *mut Value) };
                trace(&format!(
                    "pairing code {}",
                    match super::code_card(&v) {
                        super::CodeCard::Failed(_) => "failed",
                        super::CodeCard::Starting(_) => "waiting for the tunnel",
                        super::CodeCard::Code { .. } => "shown",
                    }
                ));
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

    /// How tall `s` is when wrapped to `width` in `font`.
    unsafe fn height_of(hdc: HDC, font: HFONT, s: &str, width: i32) -> i32 {
        unsafe {
            SelectObject(hdc, font as HGDIOBJ);
            let mut w = wide(s);
            let mut r = RECT { left: 0, top: 0, right: width, bottom: 0 };
            DrawTextW(hdc, w.as_mut_ptr(), -1, &mut r, DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX);
            r.bottom
        }
    }

    /// A GDI+ surface over `hdc`, anti-aliased, for the shapes and the mark.
    unsafe fn canvas(hdc: HDC) -> *mut GpGraphics {
        unsafe {
            let mut g: *mut GpGraphics = null_mut();
            GdipCreateFromHDC(hdc, &mut g);
            GdipSetSmoothingMode(g, SmoothingModeAntiAlias);
            GdipSetInterpolationMode(g, InterpolationModeHighQualityBicubic);
            GdipSetPixelOffsetMode(g, PixelOffsetModeHalf);
            g
        }
    }

    /// A rounded rectangle filled with `fill` and edged with `edge` (ARGB).
    unsafe fn rounded(g: *mut GpGraphics, r: &RECT, radius: i32, fill: u32, edge: u32) {
        unsafe {
            let mut path: *mut GpPath = null_mut();
            GdipCreatePath(FillModeAlternate, &mut path);
            let d = (radius * 2).max(1);
            let (x, y, w, h) = (r.left, r.top, r.right - r.left - 1, r.bottom - r.top - 1);
            GdipAddPathArcI(path, x, y, d, d, 180.0, 90.0);
            GdipAddPathArcI(path, x + w - d, y, d, d, 270.0, 90.0);
            GdipAddPathArcI(path, x + w - d, y + h - d, d, d, 0.0, 90.0);
            GdipAddPathArcI(path, x, y + h - d, d, d, 90.0, 90.0);
            GdipClosePathFigure(path);
            let mut brush: *mut GpSolidFill = null_mut();
            GdipCreateSolidFill(fill, &mut brush);
            GdipFillPath(g, brush as *mut GpBrush, path);
            GdipDeleteBrush(brush as *mut GpBrush);
            if edge != fill {
                let mut pen: *mut GpPen = null_mut();
                GdipCreatePen1(edge, 1.0, UnitPixel, &mut pen);
                GdipDrawPath(g, pen, path);
                GdipDeletePen(pen);
            }
            GdipDeletePath(path);
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
            let (fill, edge, ink) = match (primary, pressed) {
                (true, false) => (A_INK, A_INK, PAPER),
                (true, true) => (A_INK_PRESSED, A_INK_PRESSED, PAPER),
                (false, false) => (A_CARD, A_LINE, INK),
                (false, true) => (A_PRESSED, A_LINE, INK),
            };
            let g = canvas(hdc);
            rounded(g, &r, 8 * dpi / 96, fill, edge);
            GdipDeleteGraphics(g);
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
                let inner = right - px(CARD_PAD);
                let mut y = px(PAD);
                let lines: Vec<Line> = if st.lines.is_empty() { vec![Line { text: "Looking…".to_string(), headline: true, on: false }] } else { st.lines.clone() };
                let card_h = px(CARD_PAD) * 2 + lines.len() as i32 * px(LINE_H);
                let status_card = RECT { left, top: y + px(HEAD_H + 20), right, bottom: y + px(HEAD_H + 20) + card_h };
                let code_card =
                    st.pairing.as_ref().map(|_| RECT { left, top: status_card.bottom + px(GAP), right, bottom: status_card.bottom + px(GAP) + px(CARD_PAD) * 2 + px(QR) });

                // the shapes and the mark first, with GDI+
                let g = canvas(hdc);
                if !st.mark.is_null() {
                    GdipDrawImageRectI(g, st.mark, left, y, px(HEAD_H), px(HEAD_H));
                }
                rounded(g, &status_card, px(12), A_CARD, A_LINE);
                if let Some(c) = &code_card {
                    rounded(g, c, px(12), A_CARD, A_LINE);
                }
                // the dot by the headline: filled when it runs, a ring otherwise
                let d = px(9);
                let mut ly = status_card.top + px(CARD_PAD);
                for line in &lines {
                    if line.headline {
                        let (dx, dy) = (left + px(CARD_PAD), ly + px(LINE_H) / 2 - d / 2);
                        if line.on {
                            let mut brush: *mut GpSolidFill = null_mut();
                            GdipCreateSolidFill(A_INK, &mut brush);
                            GdipFillEllipseI(g, brush as *mut GpBrush, dx, dy, d, d);
                            GdipDeleteBrush(brush as *mut GpBrush);
                        } else {
                            let mut pen: *mut GpPen = null_mut();
                            GdipCreatePen1(A_MUTED, 1.0, UnitPixel, &mut pen);
                            GdipDrawEllipseI(g, pen, dx, dy, d - 1, d - 1);
                            GdipDeletePen(pen);
                        }
                    }
                    ly += px(LINE_H);
                }
                GdipDeleteGraphics(g);

                // then the text, with GDI
                let tx = left + px(HEAD_H + 14);
                let mut r = RECT { left: tx, top: y + px(2), right, bottom: y + px(28) };
                text(hdc, st.title, INK, "Inyon", &mut r, DT_LEFT | DT_SINGLELINE);
                let mut r = RECT { left: tx, top: y + px(28), right, bottom: y + px(HEAD_H) };
                let what = match st.role {
                    Role::Link => "paired with the phone",
                    Role::Node => "on a hub",
                    Role::Hub => "hub",
                };
                text(hdc, st.small, MUTED, &format!("{} · {what}", crate::ui::VERSION), &mut r, DT_LEFT | DT_SINGLELINE);
                y = status_card.top;
                let mut ly = y + px(CARD_PAD);
                for line in &lines {
                    let tx = left + px(CARD_PAD) + if line.headline { d + px(10) } else { 0 };
                    let mut r = RECT { left: tx, top: ly, right: inner, bottom: ly + px(LINE_H) };
                    text(hdc, st.body, if line.headline { INK } else { MUTED }, &line.text, &mut r, DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
                    ly += px(LINE_H);
                }
                y = status_card.bottom;
                if let (Some(v), Some(card)) = (&st.pairing, &code_card) {
                    let (cx, cy) = (card.left + px(CARD_PAD), card.top + px(CARD_PAD));
                    let view = super::code_card(v);
                    let qr = v.get("qr").and_then(Value::as_str).and_then(|t| QrCode::with_error_correction_level(t.as_bytes(), EcLevel::L).ok());
                    match (view, qr) {
                        (super::CodeCard::Failed(err), _) => {
                            let mut r = RECT { left: cx, top: cy, right: inner, bottom: cy + px(QR) };
                            text(hdc, st.body, INK, &format!("Couldn't make a pairing code: {err}"), &mut r, DT_LEFT | DT_WORDBREAK);
                        }
                        (super::CodeCard::Starting(what), _) | (super::CodeCard::Code { note: what }, None) => {
                            let mut r = RECT { left: cx, top: cy, right: inner, bottom: cy + px(QR) };
                            text(hdc, st.body, MUTED, what, &mut r, DT_LEFT | DT_WORDBREAK);
                        }
                        (super::CodeCard::Code { note }, Some(code)) => {
                            // the code, crisp: whole pixels per module, with a quiet zone of two
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
                            // beside it: how to use it, then the typed-in code at the bottom
                            let tx = cx + module * (n + 4) + px(16);
                            let tw = inner - tx;
                            let scan = "Scan this in the Inyon app, or with the phone's camera.";
                            let h1 = height_of(hdc, st.body, scan, tw);
                            let mut r = RECT { left: tx, top: cy, right: inner, bottom: cy + h1 };
                            text(hdc, st.body, INK, scan, &mut r, DT_LEFT | DT_WORDBREAK);
                            let h2 = height_of(hdc, st.small, note, tw);
                            let mut r = RECT { left: tx, top: cy + h1 + px(6), right: inner, bottom: cy + h1 + px(6) + h2 };
                            text(hdc, st.small, MUTED, note, &mut r, DT_LEFT | DT_WORDBREAK);
                            if let Some((id, pin)) = super::short_code(v) {
                                let base = cy + px(QR) - px(LINE_H * 3);
                                let mut r = RECT { left: tx, top: base, right: inner, bottom: base + px(LINE_H) };
                                text(hdc, st.small, MUTED, "Or type this in the app", &mut r, DT_LEFT | DT_SINGLELINE | DT_VCENTER);
                                let mut r = RECT { left: tx, top: base + px(LINE_H), right: inner, bottom: base + px(LINE_H * 2) };
                                text(hdc, st.mono, INK, &format!("ID    {id}"), &mut r, DT_LEFT | DT_SINGLELINE | DT_VCENTER);
                                let mut r = RECT { left: tx, top: base + px(LINE_H * 2), right: inner, bottom: base + px(LINE_H * 3) };
                                text(hdc, st.mono, INK, &format!("Code  {pin}"), &mut r, DT_LEFT | DT_SINGLELINE | DT_VCENTER);
                            }
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
            reach: None,
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
    fn a_stopped_link_shows_no_address_and_tunnel_only_is_said() {
        // state.json keeps the tunnel's address after the link stops; it answers nowhere then
        let mut s = status();
        s.jobs[0].running = false;
        assert!(summary(&s).iter().all(|l| !l.text.starts_with("Answers on")), "{:?}", summary(&s));
        let s = Status { reach: Some("only through the tunnel".into()), ..status() };
        assert!(summary(&s).iter().any(|l| l.text.starts_with("Tunnel only")));
    }

    #[test]
    fn the_code_card_waits_for_the_tunnel_and_then_shows_the_code() {
        let starting = serde_json::json!({ "waiting": "tunnel", "service": false });
        assert!(matches!(code_card(&starting), CodeCard::Starting(t) if t.starts_with("Starting the tunnel")));
        let slow = serde_json::json!({ "waiting": "tunnel", "qr": "https://x/#pair", "urls": [], "relays": [] });
        assert!(matches!(code_card(&slow), CodeCard::Starting(t) if t.contains("still starting")));
        let lan = serde_json::json!({ "waiting": "tunnel", "qr": "https://x/#pair", "urls": ["ws://192.168.1.20:4780/link"], "relays": [] });
        assert!(matches!(code_card(&lan), CodeCard::Code { note } if note.contains("same network")));
        let up = serde_json::json!({ "qr": "https://x/#pair", "urls": ["wss://a.trycloudflare.com/link"], "relays": [] });
        assert_eq!(code_card(&up), CodeCard::Code { note: "It works once, within 10 minutes." });
        assert_eq!(code_card(&serde_json::json!({ "error": "no" })), CodeCard::Failed("no".into()));
    }

    #[test]
    fn a_pairing_that_ends_while_the_tunnel_starts_says_why_and_a_shown_code_stays() {
        assert_eq!(pairing_ended(Err("no engine".into()), None).as_deref(), Some("no engine"));
        assert_eq!(pairing_ended(Ok(()), None).as_deref(), Some("The engine gave no code."));
        // only "Starting the tunnel…" was on screen: it doesn't stay there for good
        assert_eq!(pairing_ended(Err("killed".into()), Some(true)).as_deref(), Some("killed"));
        assert!(pairing_ended(Ok(()), Some(true)).is_some_and(|w| w.contains("before the tunnel came up")));
        // a code the phone can use stays
        assert_eq!(pairing_ended(Err("killed".into()), Some(false)), None);
        assert_eq!(pairing_ended(Ok(()), Some(false)), None);
    }

    #[test]
    fn the_typed_code_is_split_the_way_the_app_shows_it() {
        let v = serde_json::json!({ "short": { "id": "ZS5C3EPG", "code": "801356" } });
        assert_eq!(short_code(&v), Some(("ZS5C-3EPG".to_string(), "801 356".to_string())));
        assert_eq!(short_code(&serde_json::json!({})), None);
    }
}
