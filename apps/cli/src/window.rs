//! The Inyon window on Windows, opened from the tray icon: the status at a glance, a pairing
//! code drawn as a picture, and the tray's actions as buttons. It's a window of its own, so no
//! terminal opens or flashes. `inyon window <role> [--pair]` starts it; a second start brings
//! the open one to the front instead.

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

/// The lines under the heading: whether it runs, where it answers, which phones are paired.
/// The flag marks a muted line.
pub fn summary(s: &Status) -> Vec<(String, bool)> {
    let mut out = Vec::new();
    let running = s.jobs.iter().any(|j| j.running);
    let set_up = s.jobs.iter().any(|j| j.service);
    out.push(match (running, set_up, s.role.as_str()) {
        (true, _, "node") => ("●  Running: your phone can reach this computer".to_string(), false),
        (true, _, "joined") => ("●  Running: connected to your hub".to_string(), false),
        (true, _, _) => ("●  Running".to_string(), false),
        (false, true, _) => ("○  Set up, not running".to_string(), false),
        (false, false, _) => ("○  Not set up yet: run inyon setup in a terminal".to_string(), false),
    });
    if let Some(a) = s.addresses.first().or(s.relays.first()) {
        out.push((format!("Answers on {}", crate::http::host_of(a)), true));
    } else if running {
        out.push(("No address yet: the tunnel is starting".to_string(), true));
    }
    if s.phones.is_empty() {
        out.push(("No phones paired yet".to_string(), true));
    }
    for p in s.phones.iter().take(3) {
        let seen = p.last_seen.as_deref().map(|t| format!("seen {t}")).unwrap_or_else(|| "never seen".to_string());
        out.push((format!("{}  ·  {seen}", p.name), true));
    }
    if s.phones.len() > 3 {
        out.push((format!("and {} more", s.phones.len() - 3), true));
    }
    if s.pairing_open {
        out.push(("A pairing code is open".to_string(), true));
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
        BeginPaint, CreateFontW, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint, FillRect, InvalidateRect, SelectObject, SetBkMode, SetTextColor, CLEARTYPE_QUALITY,
        CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DEFAULT_PITCH, DT_END_ELLIPSIS, DT_LEFT, DT_NOPREFIX, DT_SINGLELINE, DT_WORDBREAK, FF_DONTCARE, FW_NORMAL, FW_SEMIBOLD, HBRUSH,
        HFONT, OUT_DEFAULT_PRECIS, PAINTSTRUCT, TRANSPARENT,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Threading::CreateMutexW;
    use windows_sys::Win32::UI::HiDpi::{AdjustWindowRectExForDpi, GetDpiForWindow, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, FindWindowW, GetClientRect, GetMessageW, GetSystemMetrics, LoadCursorW, PostMessageW, PostQuitMessage,
        RegisterClassW, SendMessageW, SetForegroundWindow, SetWindowPos, ShowWindow, TranslateMessage, BS_PUSHBUTTON, CS_HREDRAW, CS_VREDRAW, CW_USEDEFAULT, IDC_ARROW, MSG,
        SM_CXSCREEN, SM_CYSCREEN, SWP_NOMOVE, SWP_NOZORDER, SW_SHOWNORMAL, WM_APP, WM_COMMAND, WM_CREATE, WM_DESTROY, WM_PAINT, WM_SETFONT, WM_SIZE, WNDCLASSW, WS_CAPTION,
        WS_CHILD, WS_MINIMIZEBOX, WS_OVERLAPPED, WS_SYSMENU, WS_TABSTOP, WS_VISIBLE,
    };

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
    /// CREATE_NO_WINDOW
    const NO_WINDOW: u32 = 0x0800_0000;

    // silver and ink, as COLORREF (0x00BBGGRR)
    const PAPER: COLORREF = 0x00EC_F0F1;
    const INK: COLORREF = 0x001A_1C1D;
    const MUTED: COLORREF = 0x0066_6A6B;
    const LINE: COLORREF = 0x00D3_D8D9;
    const WHITE: COLORREF = 0x00FF_FFFF;

    /// logical pixels, scaled by the monitor's DPI
    const WIDTH: i32 = 480;
    const PAD: i32 = 24;
    const LINE_H: i32 = 26;
    const QR: i32 = 272;
    const BTN_H: i32 = 32;

    struct State {
        role: Role,
        status: Option<Status>,
        lines: Vec<(String, bool)>,
        pairing: Option<Value>,
        pairing_busy: bool,
        dpi: i32,
        title: HFONT,
        body: HFONT,
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
        unsafe {
            SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            // one window per job: a second start brings the first to the front
            let mutex = CreateMutexW(null(), 0, wide(&format!("Local\\InyonWindow-{}", role.name())).as_ptr());
            if !mutex.is_null() && GetLastError() == ERROR_ALREADY_EXISTS {
                let open = FindWindowW(wide(CLASS).as_ptr(), null());
                if !open.is_null() {
                    ShowWindow(open, SW_SHOWNORMAL);
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
                style: CS_HREDRAW | CS_VREDRAW,
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
                    status: None,
                    lines: Vec::new(),
                    pairing: None,
                    pairing_busy: false,
                    dpi: 96,
                    title: null_mut(),
                    body: null_mut(),
                    mono: null_mut(),
                    buttons: [null_mut(); 4],
                })
            });
            let style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
            let hwnd = CreateWindowExW(0, class.as_ptr(), wide("Inyon").as_ptr(), style, CW_USEDEFAULT, CW_USEDEFAULT, 10, 10, null_mut(), null_mut(), instance, null());
            if hwnd.is_null() {
                return 1;
            }
            fit(hwnd, true);
            ShowWindow(hwnd, SW_SHOWNORMAL);
            SetForegroundWindow(hwnd);
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
            0
        }
    }

    /// Sizes the window to its content and places the buttons; centred on the first showing.
    fn fit(hwnd: HWND, centre: bool) {
        unsafe {
            let (k, lines, has_qr, buttons) = STATE.with(|s| {
                let st = s.borrow();
                let st = st.as_ref().unwrap();
                (st.dpi as f32 / 96.0, st.lines.len().max(1) as i32, st.pairing.is_some(), st.buttons)
            });
            let px = |v: i32| (v as f32 * k) as i32;
            let mut h = PAD + 40 + 10 + lines * LINE_H + 12;
            if has_qr {
                h += QR + 16 + 2 * LINE_H + 8;
            }
            h += 1 + 16 + BTN_H + PAD;
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
            // four buttons across the bottom
            let gap = px(8);
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
            false
        });
        if busy {
            return;
        }
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
                let log = service::log_file(role);
                if let Some(dir) = log.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let _ = std::fs::OpenOptions::new().create(true).append(true).open(&log);
                unsafe {
                    ShellExecuteW(null_mut(), wide("open").as_ptr(), wide(&log.to_string_lossy()).as_ptr(), null(), null(), SW_SHOWNORMAL);
                }
            }
            BTN_RESTART => {
                std::thread::spawn(move || {
                    let proc = RealProc;
                    let sys = Sys::new(&proc);
                    service::restart_service(&sys, role, &[me().to_string_lossy().into_owned()]);
                });
            }
            BTN_QUIT => {
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
                    let (title, body, mono) =
                        (font(dpi, 17, FW_SEMIBOLD as i32, "Segoe UI"), font(dpi, 10, FW_NORMAL as i32, "Segoe UI"), font(dpi, 12, FW_SEMIBOLD as i32, "Consolas"));
                    let instance = GetModuleHandleW(null());
                    let labels = ["Pair a phone", "Show the log", "Restart", "Quit Inyon"];
                    let mut buttons = [null_mut(); 4];
                    for (i, label) in labels.iter().enumerate() {
                        let b = CreateWindowExW(
                            0,
                            wide("BUTTON").as_ptr(),
                            wide(label).as_ptr(),
                            WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON as u32,
                            0,
                            0,
                            10,
                            10,
                            hwnd,
                            (i + 1) as *mut _,
                            instance,
                            null(),
                        );
                        SendMessageW(b, WM_SETFONT, body as WPARAM, 1);
                        buttons[i] = b;
                    }
                    STATE.with(|s| {
                        if let Some(st) = s.borrow_mut().as_mut() {
                            st.dpi = dpi;
                            st.title = title;
                            st.body = body;
                            st.mono = mono;
                            st.buttons = buttons;
                        }
                    });
                }
                0
            }
            WM_SIZE => 0,
            WM_COMMAND => {
                act(hwnd, wparam & 0xffff);
                0
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
                    st.status = Some(*status);
                    changed
                });
                if changed {
                    fit(hwnd, false);
                    unsafe { InvalidateRect(hwnd, null(), 1) };
                }
                0
            }
            PAIRED => {
                // SAFETY: as above, from the pairing thread
                let v = unsafe { Box::from_raw(lparam as *mut Value) };
                STATE.with(|s| {
                    if let Some(st) = s.borrow_mut().as_mut() {
                        st.pairing = Some(*v);
                        st.pairing_busy = false;
                    }
                });
                fit(hwnd, false);
                unsafe { InvalidateRect(hwnd, null(), 1) };
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
                            for f in [st.title, st.body, st.mono] {
                                if !f.is_null() {
                                    DeleteObject(f as *mut _);
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

    fn paint(hwnd: HWND) {
        unsafe {
            let mut ps: PAINTSTRUCT = std::mem::zeroed();
            let hdc = BeginPaint(hwnd, &mut ps);
            let mut client: RECT = std::mem::zeroed();
            GetClientRect(hwnd, &mut client);
            let paper = CreateSolidBrush(PAPER);
            FillRect(hdc, &client, paper);
            DeleteObject(paper as *mut _);
            SetBkMode(hdc, TRANSPARENT as i32);
            STATE.with(|s| {
                let st = s.borrow();
                let Some(st) = st.as_ref() else { return };
                let k = st.dpi as f32 / 96.0;
                let px = |v: i32| (v as f32 * k) as i32;
                let text = |font: HFONT, color: COLORREF, s: &str, r: &mut RECT, flags: u32| {
                    SelectObject(hdc, font as *mut _);
                    SetTextColor(hdc, color);
                    let mut w = wide(s);
                    DrawTextW(hdc, w.as_mut_ptr(), -1, r, flags | DT_NOPREFIX);
                };
                let left = px(PAD);
                let right = px(WIDTH - PAD);
                let mut y = px(PAD);
                // heading: the name, the version beside it
                let mut r = RECT { left, top: y, right, bottom: y + px(32) };
                text(st.title, INK, "Inyon", &mut r, DT_LEFT | DT_SINGLELINE);
                let mut r = RECT { left: left + px(72), top: y + px(9), right, bottom: y + px(32) };
                text(st.body, MUTED, &format!("{} · {}", crate::ui::VERSION, super::super::service::Role::name(st.role)), &mut r, DT_LEFT | DT_SINGLELINE);
                y += px(40 + 10);
                let lines: Vec<(String, bool)> = if st.lines.is_empty() { vec![("Looking…".to_string(), true)] } else { st.lines.clone() };
                for (line, muted) in &lines {
                    let mut r = RECT { left, top: y, right, bottom: y + px(LINE_H) };
                    text(st.body, if *muted { MUTED } else { INK }, line, &mut r, DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS);
                    y += px(LINE_H);
                }
                y += px(12);
                if let Some(v) = &st.pairing {
                    if let Some(err) = v.get("error").and_then(Value::as_str) {
                        let mut r = RECT { left, top: y, right, bottom: y + px(QR) };
                        text(st.body, INK, &format!("Couldn't make a pairing code: {err}"), &mut r, DT_LEFT | DT_WORDBREAK);
                    } else if let Some(code) = v.get("qr").and_then(Value::as_str).and_then(|t| QrCode::with_error_correction_level(t.as_bytes(), EcLevel::L).ok()) {
                        // the code on a white card, with a quiet zone of four modules
                        let n = code.width() as i32;
                        let module = (px(QR) / (n + 8)).max(1);
                        let side = module * (n + 8);
                        let card = RECT { left, top: y, right: left + side, bottom: y + side };
                        let white = CreateSolidBrush(WHITE);
                        FillRect(hdc, &card, white);
                        DeleteObject(white as *mut _);
                        let ink = CreateSolidBrush(INK);
                        let modules = code.to_colors();
                        for (i, c) in modules.iter().enumerate() {
                            if *c == Color::Dark {
                                let (x, yy) = ((i as i32) % n, (i as i32) / n);
                                let r = RECT { left: left + (x + 4) * module, top: y + (yy + 4) * module, right: left + (x + 5) * module, bottom: y + (yy + 5) * module };
                                FillRect(hdc, &r, ink);
                            }
                        }
                        DeleteObject(ink as *mut _);
                        // beside it: how to use it, and the typed-in code
                        let tx = left + side + px(20);
                        let mut r = RECT { left: tx, top: y, right, bottom: y + px(LINE_H * 4) };
                        text(
                            st.body,
                            INK,
                            "Scan it in the Inyon app (Add a computer → Scan the code), or with the phone's camera. It works once, within 10 minutes.",
                            &mut r,
                            DT_LEFT | DT_WORDBREAK,
                        );
                        if let Some((id, pin)) = super::short_code(v) {
                            let mut r = RECT { left: tx, top: y + px(LINE_H * 4 + 8), right, bottom: y + px(LINE_H * 5 + 8) };
                            text(st.body, MUTED, "Can't scan? Type a code:", &mut r, DT_LEFT | DT_SINGLELINE);
                            let mut r = RECT { left: tx, top: y + px(LINE_H * 5 + 8), right, bottom: y + px(LINE_H * 6 + 8) };
                            text(st.mono, INK, &format!("ID  {id}"), &mut r, DT_LEFT | DT_SINGLELINE);
                            let mut r = RECT { left: tx, top: y + px(LINE_H * 6 + 8), right, bottom: y + px(LINE_H * 7 + 8) };
                            text(st.mono, INK, &format!("Code  {pin}"), &mut r, DT_LEFT | DT_SINGLELINE);
                        }
                    }
                    y += px(QR + 16);
                    let mut r = RECT { left, top: y, right, bottom: y + px(2 * LINE_H) };
                    text(st.body, MUTED, "Paired phones connect by themselves from now on.", &mut r, DT_LEFT | DT_WORDBREAK);
                    y += px(2 * LINE_H + 8);
                } else if st.pairing_busy {
                    let mut r = RECT { left, top: y, right, bottom: y + px(LINE_H) };
                    text(st.body, MUTED, "Making a pairing code…", &mut r, DT_LEFT | DT_SINGLELINE);
                }
                // a rule above the buttons
                let rule = RECT { left, top: y, right, bottom: y + 1 };
                let line: HBRUSH = CreateSolidBrush(LINE);
                FillRect(hdc, &rule, line);
                DeleteObject(line as *mut _);
            });
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
        assert_eq!(lines[0].0, "●  Running: your phone can reach this computer");
        assert_eq!(lines[1], ("Answers on quiet-otter.trycloudflare.com".to_string(), true));
        assert_eq!(lines[2], ("Nothing A142  ·  seen 22:27".to_string(), true));
        let mut s = status();
        s.jobs[0].running = false;
        s.addresses.clear();
        s.phones.clear();
        let lines = summary(&s);
        assert_eq!(lines[0].0, "○  Set up, not running");
        assert_eq!(lines[1].0, "No phones paired yet");
    }

    #[test]
    fn the_typed_code_is_split_the_way_the_app_shows_it() {
        let v = serde_json::json!({ "short": { "id": "ZS5C3EPG", "code": "801356" } });
        assert_eq!(short_code(&v), Some(("ZS5C-3EPG".to_string(), "801 356".to_string())));
        assert_eq!(short_code(&serde_json::json!({})), None);
    }
}
