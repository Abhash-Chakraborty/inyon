//! The Win32 window: draws a [`View`] in the rectangles [`layout`] gives, and turns clicks into
//! the view's actions. The window's size comes from the DPI and the work area alone; it's set when
//! the window opens and again on WM_DPICHANGED, never when the state changes.
//!
//! `INYON_WINDOW_DEMO=<file>` is for checking the window on a real screen: it opens a window of
//! its own (another class and mutex, so it never hands over to the real one), starts no threads and
//! does nothing a button asks for. Each line written to the file is read within half a second:
//! `state=<name>` (one of [`demo::NAMES`]), `dpi=<96..>`, `work=<w>x<h>`, `theme=light|dark`,
//! `tab=<0..2>`, in any mix. Every change, and the window's size after it, goes to window.log.

use std::cell::RefCell;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::ptr::{null, null_mut};

use qrcode::{Color, EcLevel, QrCode};
use serde_json::Value;
use windows_sys::Win32::Foundation::{GetLastError, COLORREF, ERROR_ALREADY_EXISTS, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_USE_IMMERSIVE_DARK_MODE};
use windows_sys::Win32::Graphics::Gdi::{
    BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateFontW, CreateSolidBrush, DeleteDC, DeleteObject, DrawTextW, EndPaint, FillRect, GetMonitorInfoW,
    GetTextExtentPoint32W, InvalidateRect, MonitorFromPoint, MonitorFromRect, MonitorFromWindow, SelectObject, SetBkMode, SetTextColor, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS,
    DEFAULT_CHARSET, DEFAULT_PITCH, DT_CENTER, DT_END_ELLIPSIS, DT_LEFT, DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER, FF_DONTCARE, FW_NORMAL, FW_SEMIBOLD, HDC, HFONT, HGDIOBJ,
    HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST, OUT_DEFAULT_PRECIS, PAINTSTRUCT, SRCCOPY, TRANSPARENT,
};
use windows_sys::Win32::Graphics::GdiPlus::{
    DashStyleDash, FillModeAlternate, GdipAddPathArcI, GdipClosePathFigure, GdipCreateFromHDC, GdipCreatePath, GdipCreatePen1, GdipCreateSolidFill, GdipDeleteBrush,
    GdipDeleteGraphics, GdipDeletePath, GdipDeletePen, GdipDrawEllipseI, GdipDrawImageRectI, GdipDrawLineI, GdipDrawPath, GdipFillEllipseI, GdipFillPath, GdipLoadImageFromStream,
    GdipSetInterpolationMode, GdipSetPenDashStyle, GdipSetPixelOffsetMode, GdipSetSmoothingMode, GdiplusStartup, GdiplusStartupInput, GpBrush, GpGraphics, GpImage, GpPath, GpPen,
    GpSolidFill, InterpolationModeHighQualityBicubic, PixelOffsetModeHalf, SmoothingModeAntiAlias, UnitPixel,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
use windows_sys::Win32::System::Threading::CreateMutexW;
use windows_sys::Win32::UI::Controls::{DRAWITEMSTRUCT, ODS_FOCUS, ODS_NOFOCUSRECT, ODS_SELECTED};
use windows_sys::Win32::UI::HiDpi::{
    AdjustWindowRectExForDpi, GetDpiForMonitor, GetDpiForWindow, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, MDT_EFFECTIVE_DPI,
};
use windows_sys::Win32::UI::Shell::{SHCreateMemStream, ShellExecuteW};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, FindWindowW, GetClientRect, GetCursorPos, GetMessageW, GetWindowRect, IsDialogMessageW, IsIconic, KillTimer,
    LoadCursorW, PostMessageW, PostQuitMessage, RegisterClassW, SetForegroundWindow, SetTimer, SetWindowPos, ShowWindow, TranslateMessage, BS_OWNERDRAW, IDCANCEL, IDC_ARROW, MSG,
    SWP_NOACTIVATE, SWP_NOZORDER, SW_HIDE, SW_SHOW, SW_SHOWNOACTIVATE, WINDOW_STYLE, WM_APP, WM_CLOSE, WM_COMMAND, WM_CREATE, WM_DESTROY, WM_DPICHANGED, WM_DRAWITEM,
    WM_ERASEBKGND, WM_GETDPISCALEDSIZE, WM_PAINT, WM_SETTINGCHANGE, WM_SIZE, WM_TIMER, WNDCLASSW, WS_CAPTION, WS_CHILD, WS_CLIPCHILDREN, WS_MINIMIZEBOX, WS_OVERLAPPED, WS_SYSMENU,
    WS_TABSTOP,
};

use super::demo;
use super::layout::{fit_lines, layout, Id, Layout, Mode, Rect};
use super::model::{self, view, Action, Card, Checks, Dot, Extra, Glyph, Pairing, Update, View, UNDO_MS};
use super::trace;
use crate::paths;
use crate::service::{self, Role, Sys};
use crate::sys::RealProc;
use crate::ui::dashboard::{gather, Status};

const CLASS: &str = "InyonWindow";
/// the demo mode's window, which never meets the real one
const DEMO_CLASS: &str = "InyonWindowDemo";
/// the mark at 512 px, drawn down to size with a smooth filter
const MARK: &[u8] = include_bytes!("../../assets/inyon-512.png");
/// a fresh status (lparam: Box<Tick>)
const STATUS: u32 = WM_APP + 2;
/// the engine answered the pairing request (lparam: Box<(u32, Value)>, the request's number first)
const PAIRED: u32 = WM_APP + 3;
/// show a pairing code (a second `--pair` start sends this to the open window)
const PAIR_NOW: u32 = WM_APP + 4;
/// one of the window's threads found something out (lparam: Box<Found>)
const FOUND: u32 = WM_APP + 5;
/// counts down a Forget's Undo and a code's last minute
const TICK: usize = 1;
/// reads the demo file
const DEMO_TICK: usize = 2;
/// no resizing border and no maximise: the window has one size per scale
const STYLE: WINDOW_STYLE = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_CLIPCHILDREN;
/// CREATE_NO_WINDOW, CREATE_NEW_CONSOLE
const NO_WINDOW: u32 = 0x0800_0000;
const NEW_CONSOLE: u32 = 0x0000_0010;

/// The first button's control id; the ones below are the keyboard's (Enter is IDOK, Esc IDCANCEL).
const FIRST_ID: usize = 100;
/// Every button the window can show, in either layout; its control id is FIRST_ID plus its place here.
const BUTTONS: [Id; 15] = [
    Id::Tab(0),
    Id::Tab(1),
    Id::Tab(2),
    Id::Primary,
    Id::Secondary,
    Id::Change,
    Id::ShowAll,
    Id::Forget(0),
    Id::Forget(1),
    Id::SvcA,
    Id::SvcB,
    Id::UpdateBtn,
    Id::CheckBtn,
    Id::OpenLog,
    Id::Quit,
];

/// What the status thread brings every 2 s: the status, how phones may reach the link, and the
/// update's progress line.
struct Tick {
    status: Status,
    reach: (bool, bool, bool),
    update: Option<String>,
}

enum Found {
    Agents(Vec<String>),
    Update(Update),
    Checks(Checks),
}

/// Silver and ink, light or graphite: inyon-design's tokens.
#[derive(Clone, Copy)]
struct Palette {
    ground: u32,
    panel: u32,
    raised: u32,
    pressed: u32,
    line: u32,
    line_strong: u32,
    fg: u32,
    fg2: u32,
    fg3: u32,
    accent: u32,
    accent_fg: u32,
    accent_pressed: u32,
    warn: u32,
    danger: u32,
}

const LIGHT: Palette = Palette {
    ground: 0xe9e8e4,
    panel: 0xf4f3f0,
    raised: 0xecebe7,
    pressed: 0xe2e1dc,
    line: 0xd6d5cf,
    line_strong: 0xbdbcb5,
    fg: 0x1d1c1a,
    fg2: 0x4a4844,
    fg3: 0x5f5d58,
    accent: 0x1d1c1a,
    accent_fg: 0xf4f3f0,
    accent_pressed: 0x45433f,
    warn: 0x8f5a12,
    danger: 0xb23a32,
};

const DARK: Palette = Palette {
    ground: 0x1b1a18,
    panel: 0x252422,
    raised: 0x2a2927,
    pressed: 0x302e2b,
    line: 0x33312e,
    line_strong: 0x45433f,
    fg: 0xf1f0ec,
    fg2: 0xb4b2ab,
    fg3: 0xa19f95,
    accent: 0xf1f0ec,
    accent_fg: 0x1b1a18,
    accent_pressed: 0xbdbcb5,
    warn: 0xe6b45c,
    danger: 0xf08a7e,
};

/// #RRGGBB as GDI wants it (0x00BBGGRR) and as GDI+ wants it (0xAARRGGBB).
fn cref(rgb: u32) -> COLORREF {
    ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff)
}

fn argb(rgb: u32) -> u32 {
    0xff00_0000 | rgb
}

struct Fonts {
    title: HFONT,
    body: HFONT,
    strong: HFONT,
    small: HFONT,
    strike: HFONT,
    log: HFONT,
    code: HFONT,
}

impl Fonts {
    fn new(dpi: u32) -> Fonts {
        Fonts {
            title: font(dpi, 15, FW_SEMIBOLD as i32, false, "Segoe UI"),
            body: font(dpi, 13, FW_NORMAL as i32, false, "Segoe UI"),
            strong: font(dpi, 13, FW_SEMIBOLD as i32, false, "Segoe UI"),
            small: font(dpi, 12, FW_NORMAL as i32, false, "Segoe UI"),
            strike: font(dpi, 12, FW_NORMAL as i32, true, "Segoe UI"),
            log: font(dpi, 12, FW_NORMAL as i32, false, "Consolas"),
            code: font(dpi, 15, FW_SEMIBOLD as i32, false, "Consolas"),
        }
    }

    fn delete(&self) {
        for f in [self.title, self.body, self.strong, self.small, self.strike, self.log, self.code] {
            if !f.is_null() {
                unsafe { DeleteObject(f as HGDIOBJ) };
            }
        }
    }
}

struct State {
    role: Role,
    dpi: u32,
    layout: Layout,
    tab: u8,
    palette: Palette,
    fonts: Fonts,
    mark: *mut GpImage,
    buttons: Vec<(Id, HWND)>,
    status: Option<Status>,
    pairing: Pairing,
    /// the number of the newest pairing request; answers to an older one are dropped
    asked: u32,
    extra: Extra,
    view: Option<View>,
    /// a code is shown unasked once, when no phone is paired yet
    offered: bool,
    demo: Option<Demo>,
    /// the tab the buttons were last drawn for (a tab's own button looks pressed)
    drawn_tab: u8,
    /// every button is drawn again on the next refresh: the theme or the scale changed
    repaint: bool,
}

/// The demo mode: the file it reads, what it last said, and the scale and work area it asks for
/// in place of the monitor's.
struct Demo {
    file: PathBuf,
    last: String,
    dpi: Option<u32>,
    work: Option<(i32, i32)>,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

fn with<R>(f: impl FnOnce(&mut State) -> R) -> Option<R> {
    STATE.with(|s| s.borrow_mut().as_mut().map(f))
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn me() -> std::path::PathBuf {
    std::env::current_exe().unwrap_or_else(|_| paths::installed_binary())
}

/// A font `px` pixels high at 96 dpi.
fn font(dpi: u32, px: i32, weight: i32, strike: bool, face: &str) -> HFONT {
    unsafe {
        CreateFontW(
            -super::layout::px(px, dpi),
            0,
            0,
            0,
            weight,
            0,
            0,
            strike as u32,
            DEFAULT_CHARSET as u32,
            OUT_DEFAULT_PRECIS as u32,
            CLIP_DEFAULT_PRECIS as u32,
            CLEARTYPE_QUALITY as u32,
            (DEFAULT_PITCH | FF_DONTCARE) as u32,
            wide(face).as_ptr(),
        )
    }
}

/// Whether Windows is set to dark mode for apps.
fn dark_mode() -> bool {
    let mut v: u32 = 1;
    let mut size = std::mem::size_of::<u32>() as u32;
    let key = wide("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize");
    let name = wide("AppsUseLightTheme");
    let r = unsafe { RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), RRF_RT_REG_DWORD, null_mut(), &mut v as *mut u32 as *mut _, &mut size) };
    r == 0 && v == 0
}

/// The title bar follows the theme too. Windows 10 before 20H1 knows the attribute as 19.
fn title_bar(hwnd: HWND, dark: bool) {
    let on: i32 = dark as i32;
    let set = |attr: u32| unsafe { DwmSetWindowAttribute(hwnd, attr, &on as *const i32 as *const _, 4) };
    if set(DWMWA_USE_IMMERSIVE_DARK_MODE as u32) != 0 {
        set(19);
    }
}

/// Where the window is and how big, and its client area, for the log.
fn geometry(hwnd: HWND) -> String {
    let mut w = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    let mut c = w;
    unsafe {
        GetWindowRect(hwnd, &mut w);
        GetClientRect(hwnd, &mut c);
    }
    format!("window {},{} {}x{}, client {}x{}", w.left, w.top, w.right - w.left, w.bottom - w.top, c.right - c.left, c.bottom - c.top)
}

/// The monitor's work area, or the demo's made-up one at its top left.
fn work_for(monitor: HMONITOR, demo: Option<(i32, i32)>) -> Rect {
    let work = work_area(monitor);
    match demo {
        Some((w, h)) => Rect::new(work.x, work.y, w, h),
        None => work,
    }
}

fn work_area(monitor: HMONITOR) -> Rect {
    unsafe {
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut mi) == 0 {
            return Rect::new(0, 0, 1366, 728);
        }
        let r = mi.rcWork;
        Rect::new(r.left, r.top, r.right - r.left, r.bottom - r.top)
    }
}

/// The title bar and borders at `dpi`, as Windows adds them.
fn frame_for(dpi: u32) -> (i32, i32) {
    let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    if unsafe { AdjustWindowRectExForDpi(&mut r, STYLE, 0, 0, dpi) } == 0 {
        return super::layout::frame_estimate(dpi);
    }
    (r.right - r.left, r.bottom - r.top)
}

pub fn run(role: Role, pair: bool) -> i32 {
    let demo = std::env::var_os("INYON_WINDOW_DEMO").filter(|v| !v.is_empty()).map(|f| Demo { file: PathBuf::from(f), last: String::new(), dpi: None, work: None });
    let class_name = if demo.is_some() { DEMO_CLASS } else { CLASS };
    trace(&format!("start {role}{}{}", if pair { " --pair" } else { "" }, if demo.is_some() { " (demo)" } else { "" }));
    unsafe {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        // one window per job: a second start brings the first to the front
        let mutex = CreateMutexW(null(), 0, wide(&format!("Local\\{class_name}-{}", role.name())).as_ptr());
        if !mutex.is_null() && GetLastError() == ERROR_ALREADY_EXISTS {
            let open = FindWindowW(wide(class_name).as_ptr(), null());
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
        let class = wide(class_name);
        let wc = WNDCLASSW {
            lpfnWndProc: Some(proc_),
            hInstance: instance,
            hIcon: crate::tray::win::icon_sized(32, 32),
            hCursor: LoadCursorW(null_mut(), IDC_ARROW),
            lpszClassName: class.as_ptr(),
            ..std::mem::zeroed()
        };
        RegisterClassW(&wc);
        // the monitor the tray was clicked on, and its work area: the taskbar never covers the window
        let mut at = POINT { x: 0, y: 0 };
        GetCursorPos(&mut at);
        let monitor = MonitorFromPoint(at, MONITOR_DEFAULTTONEAREST);
        let (mut dpi, mut dpi_y) = (96u32, 96u32);
        if GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi, &mut dpi_y) != 0 {
            dpi = 96;
        }
        let work = work_area(monitor);
        let frame = frame_for(dpi);
        let l = layout(dpi, work, frame);
        let place = super::layout::place(work, l.outer(frame));
        trace(&format!("{}% on a {}x{} work area: {:?}, {}x{}", dpi * 100 / 96, work.w, work.h, l.mode, place.w, place.h));
        let palette = if dark_mode() { DARK } else { LIGHT };
        let hostname = inyon_engine::hostname();
        STATE.with(|s| {
            *s.borrow_mut() = Some(State {
                role,
                dpi,
                layout: l,
                tab: 0,
                palette,
                fonts: Fonts::new(dpi),
                mark,
                buttons: Vec::new(),
                status: None,
                pairing: Pairing::default(),
                asked: 0,
                extra: Extra {
                    hostname,
                    reach: model::reach(&crate::state::link_config(), true),
                    agents: Vec::new(),
                    update: Update::Looking,
                    checks: Checks::Running,
                    hub_url: (role == Role::Hub).then(|| crate::commands::hub_local_url(&paths::read_env_file(&paths::data_dir().join("hub.env")))),
                    forgetting: None,
                },
                view: None,
                offered: pair,
                demo,
                drawn_tab: 0,
                repaint: false,
            })
        });
        let demo = with(|st| st.demo.is_some()).unwrap_or(false);
        let title = wide("Inyon");
        let hwnd = CreateWindowExW(0, class.as_ptr(), title.as_ptr(), STYLE, place.x, place.y, place.w, place.h, null_mut(), null_mut(), instance, null());
        if hwnd.is_null() {
            trace(&format!("no window: error {}", GetLastError()));
            return 1;
        }
        title_bar(hwnd, palette.accent == DARK.accent);
        if demo {
            // a check on someone's screen doesn't take the keyboard from what they're doing
            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        } else {
            ShowWindow(hwnd, SW_SHOW);
            SetForegroundWindow(hwnd);
        }
        SetTimer(hwnd, TICK, 1000, None);
        trace(&format!("shown: {}", geometry(hwnd)));
        if demo {
            // nothing of this computer's: the states come from the file
            SetTimer(hwnd, DEMO_TICK, 500, None);
            demo_read(hwnd);
        } else {
            start_threads(hwnd);
            if pair {
                PostMessageW(hwnd, PAIR_NOW, 0, 0);
            }
        }
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
            // Tab moves between the buttons, Space and Enter press them
            if IsDialogMessageW(hwnd, &msg) == 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        KillTimer(hwnd, TICK);
        KillTimer(hwnd, DEMO_TICK);
        trace("closed");
        0
    }
}

/// Posts `value` to the window, or frees it when the window has gone.
fn post<T>(hwnd: usize, msg: u32, value: T) {
    let b = Box::into_raw(Box::new(value));
    // SAFETY: the window takes the box with the message; if it's gone, it's ours to free
    unsafe {
        if PostMessageW(hwnd as HWND, msg, 0, b as LPARAM) == 0 {
            drop(Box::from_raw(b));
        }
    }
}

/// Everything slow happens on threads of their own, never on the window's: the status (Task
/// Scheduler takes a moment), the agents on PATH, the update check (the network) and the checks.
fn start_threads(hwnd: HWND) {
    let target = hwnd as usize;
    std::thread::spawn(move || loop {
        let proc = RealProc;
        let sys = Sys::new(&proc);
        let status = gather(&sys, false);
        let reach = model::reach(&crate::state::link_config(), true);
        let update = std::fs::read_to_string(crate::update::status_file()).ok().map(|s| s.trim().to_string());
        let tick = Box::into_raw(Box::new(Tick { status, reach, update }));
        // SAFETY: as in post(); a window that's gone ends this thread
        unsafe {
            if PostMessageW(target as HWND, STATUS, 0, tick as LPARAM) == 0 {
                drop(Box::from_raw(tick));
                return;
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(2));
    });
    std::thread::spawn(move || {
        let agents = ["claude", "codex", "gemini", "opencode"].into_iter().filter(|a| crate::sys::which(a).is_some()).map(String::from).collect();
        post(target, FOUND, Found::Agents(agents));
    });
    std::thread::spawn(move || {
        let found = match crate::update::latest_version(crate::update::RELEASES) {
            Ok(v) if crate::update::is_newer(&v, crate::ui::VERSION) => Update::Available(v),
            Ok(_) => Update::Current,
            Err(e) => {
                trace(&format!("no update check: {e}"));
                Update::Failed
            }
        };
        post(target, FOUND, Found::Update(found));
    });
    run_checks(target);
}

fn run_checks(target: usize) {
    std::thread::spawn(move || {
        let proc = RealProc;
        let sys = Sys::new(&proc);
        let checks = match crate::commands::doctor(&sys) {
            Ok(v) => Checks::from_doctor(&v),
            Err(e) => {
                trace(&format!("checks failed: {e}"));
                Checks::Done { total: 1, failing: vec!["doctor".into()] }
            }
        };
        post(target, FOUND, Found::Checks(checks));
    });
}

/// Works the view out again, shows the buttons it has and hides the others, and repaints. A
/// button is redrawn only when what it says changed, so the 2 s refresh doesn't flicker.
fn refresh(hwnd: HWND) {
    let buttons = with(|st| {
        let before = st.view.take();
        st.view = st.status.as_ref().map(|s| {
            let now = crate::state::now_ms();
            let today = crate::state::format_date(now);
            view(st.role, s, &st.pairing, &st.extra, now, &today)
        });
        let tab_changed = std::mem::replace(&mut st.drawn_tab, st.tab) != st.tab || std::mem::take(&mut st.repaint);
        st.buttons
            .iter()
            .map(|(id, b)| {
                let shown = st.view.as_ref().is_some_and(|v| v.button(*id).is_some()) && st.layout.items.iter().any(|i| i.id == *id) && st.layout.shown(*id, st.tab);
                let changed = tab_changed || before.as_ref().and_then(|v| v.button(*id)) != st.view.as_ref().and_then(|v| v.button(*id));
                (*b, shown, changed)
            })
            .collect::<Vec<_>>()
    })
    .unwrap_or_default();
    unsafe {
        for (b, shown, changed) in buttons {
            ShowWindow(b, if shown { SW_SHOW } else { SW_HIDE });
            if changed {
                InvalidateRect(b, null(), 0);
            }
        }
        InvalidateRect(hwnd, null(), 0);
    }
}

/// Puts every button in its rectangle for the current layout.
fn place_buttons() {
    let places = with(|st| st.buttons.iter().map(|(id, b)| (*b, st.layout.items.iter().find(|i| i.id == *id).map(|i| i.rect))).collect::<Vec<_>>()).unwrap_or_default();
    for (b, r) in places {
        if let Some(r) = r {
            unsafe { SetWindowPos(b, null_mut(), r.x, r.y, r.w, r.h, SWP_NOZORDER | SWP_NOACTIVATE) };
        }
    }
}

/// Lays the window out for `dpi` in `work` and gives it that size: at `origin` (WM_DPICHANGED's
/// suggestion), else centred in the work area. `frame_dpi` is the scale of the monitor the window
/// is on, which sizes the title bar (the demo can draw at another scale than its monitor's).
/// Only a scale or monitor change and the demo come here; a new state never does.
fn apply_layout(hwnd: HWND, dpi: u32, frame_dpi: u32, work: Rect, origin: Option<(i32, i32)>) {
    let frame = frame_for(frame_dpi);
    let l = layout(dpi, work, frame);
    let (w, h) = l.outer(frame);
    let at = match origin {
        Some((x, y)) => Rect::new(x, y, w, h),
        None => super::layout::place(work, (w, h)),
    };
    let mode = l.mode;
    with(|st| {
        if st.dpi != dpi {
            st.fonts.delete();
            st.fonts = Fonts::new(dpi);
            st.dpi = dpi;
        }
        if mode == Mode::Wide {
            st.tab = 0;
        }
        st.layout = l;
        st.repaint = true;
    });
    unsafe { SetWindowPos(hwnd, null_mut(), at.x, at.y, at.w, at.h, SWP_NOZORDER | SWP_NOACTIVATE) };
    place_buttons();
    refresh(hwnd);
    trace(&format!("laid out at {}% in a {}x{} work area ({mode:?}): {}", dpi * 100 / 96, work.w, work.h, geometry(hwnd)));
}

/// Reads the demo file and shows what it asks for, when it changed.
fn demo_read(hwnd: HWND) {
    let Some(text) =
        with(|st| st.demo.as_ref().map(|d| (std::fs::read_to_string(&d.file).unwrap_or_default(), d.last.clone()))).flatten().and_then(|(now, last)| (now != last).then_some(now))
    else {
        return;
    };
    with(|st| {
        if let Some(d) = st.demo.as_mut() {
            d.last = text.clone();
        }
    });
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let (mut relayout, mut dark) = (false, None);
    for part in text.split_whitespace() {
        let Some((k, v)) = part.split_once('=') else { continue };
        match k {
            "state" => match demo::state(v, crate::state::now_ms()) {
                Some((role, status, pairing, extra)) => {
                    with(|st| {
                        st.role = role;
                        st.status = Some(status);
                        st.pairing = pairing;
                        st.extra = extra;
                    });
                }
                None => trace(&format!("demo: no state {v}; there are {}", demo::NAMES.join(", "))),
            },
            "dpi" => {
                let dpi = v.parse::<u32>().ok().filter(|d| (96..=480).contains(d));
                relayout |= with(|st| st.demo.as_mut().map(|d| std::mem::replace(&mut d.dpi, dpi) != dpi)).flatten().unwrap_or(false);
            }
            "work" => {
                let work = v.split_once('x').and_then(|(w, h)| Some((w.parse::<i32>().ok()?, h.parse::<i32>().ok()?)));
                relayout |= with(|st| st.demo.as_mut().map(|d| std::mem::replace(&mut d.work, work) != work)).flatten().unwrap_or(false);
            }
            "theme" => dark = Some(v == "dark"),
            "tab" => {
                if let Ok(t) = v.parse::<u8>() {
                    with(|st| st.tab = t.min(2));
                }
            }
            _ => trace(&format!("demo: {k} isn't something it reads")),
        }
    }
    if let Some(dark) = dark {
        with(|st| {
            st.palette = if dark { DARK } else { LIGHT };
            st.repaint = true;
        });
        title_bar(hwnd, dark);
    }
    if relayout {
        let real = unsafe { GetDpiForWindow(hwnd) };
        let (dpi, work) = with(|st| st.demo.as_ref().map(|d| (d.dpi, d.work))).flatten().unwrap_or((None, None));
        let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
        apply_layout(hwnd, dpi.unwrap_or(real), real, work_for(monitor, work), None);
    } else {
        refresh(hwnd);
    }
    trace(&format!("demo {line}: {}", geometry(hwnd)));
}

fn start_pairing(hwnd: HWND) {
    let Some(Some(n)) = with(|st| {
        let phones = st.status.as_ref().map(|s| s.phones.clone()).unwrap_or_default();
        if !st.pairing.ask(&phones, crate::state::now_ms()) {
            return None;
        }
        st.asked += 1;
        Some(st.asked)
    }) else {
        return;
    };
    trace("asking the engine for a pairing code");
    refresh(hwnd);
    let target = hwnd as usize;
    std::thread::spawn(move || {
        // each answer is shown as it comes: the engine stays on when it started the link
        // itself, so it may never return
        let mut last_starting = None;
        let r = crate::engine::pair(&[], &mut |v| {
            last_starting = Some(matches!(super::code_card(v), super::CodeCard::Starting(_)));
            post(target, PAIRED, (n, v.clone()));
        });
        if let Err(e) = &r {
            trace(&format!("the pairing's engine ended: {e}"));
        }
        if let Some(why) = super::pairing_ended(r, last_starting) {
            post(target, PAIRED, (n, serde_json::json!({ "error": why })));
        }
    });
}

/// Opens a terminal running `inyon <args>`, left open so its output can be read.
fn open_terminal(args: &[&str]) {
    trace(&format!("opening a terminal for inyon {}", args.join(" ")));
    let exe = me();
    let _ = std::process::Command::new("cmd.exe").raw_arg(format!("/k \"\"{}\" {}\"", exe.display(), args.join(" "))).creation_flags(NEW_CONSOLE).spawn();
}

fn open(target: &str) {
    unsafe { ShellExecuteW(null_mut(), wide("open").as_ptr(), wide(target).as_ptr(), null(), null(), SW_SHOW) };
}

fn open_log(role: Role) {
    trace("opening the log");
    let log = service::log_file(role);
    if let Some(dir) = log.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::OpenOptions::new().create(true).append(true).open(&log);
    open(&log.to_string_lossy());
}

/// Puts `text` on the clipboard, through clip.exe (the pairing link and the hub's address are
/// plain ASCII).
fn copy(text: &str) {
    use std::io::Write;
    if let Ok(mut c) = std::process::Command::new("clip.exe").stdin(std::process::Stdio::piped()).creation_flags(NO_WINDOW).spawn() {
        if let Some(mut i) = c.stdin.take() {
            let _ = i.write_all(text.as_bytes());
        }
        let _ = c.wait();
    }
}

fn act(hwnd: HWND, action: Action) {
    let Some((role, link, hub, phones, pid)) = with(|st| {
        (
            st.role,
            st.pairing.answer.as_ref().and_then(|v| v.get("link")).and_then(Value::as_str).map(String::from),
            st.extra.hub_url.clone(),
            st.status.as_ref().map(|s| s.phones.clone()).unwrap_or_default(),
            crate::update::read_running(st.role).and_then(|r| r.pid),
        )
    }) else {
        return;
    };
    let target = hwnd as usize;
    if with(|st| st.demo.is_some()).unwrap_or(false) && !matches!(action, Action::Tab(_) | Action::Forget(_) | Action::Undo) {
        trace(&format!("demo: {action:?} does nothing here"));
        return;
    }
    match action {
        Action::MakeCode => start_pairing(hwnd),
        Action::OpenSetup => open_terminal(&["setup"]),
        Action::OpenHub => open(hub.as_deref().unwrap_or("http://127.0.0.1:4777")),
        Action::CopyLink => copy(link.as_deref().unwrap_or_default()),
        Action::CopyAddress => copy(hub.as_deref().unwrap_or_default()),
        Action::ShowLog | Action::OpenLog => open_log(role),
        Action::ShowAll => open_terminal(&["phones"]),
        Action::Details => open_terminal(&["doctor"]),
        Action::Forget(i) => {
            if let Some(p) = phones.get(i as usize) {
                trace(&format!("forgetting {} in 5 s unless undone", p.name));
                with(|st| st.extra.forgetting = Some((p.key.clone(), crate::state::now_ms() + UNDO_MS)));
            }
        }
        Action::Undo => {
            trace("forget undone");
            with(|st| st.extra.forgetting = None);
        }
        Action::Start | Action::Restart => {
            trace(if action == Action::Start { "starting" } else { "restarting" });
            std::thread::spawn(move || {
                let proc = RealProc;
                let sys = Sys::new(&proc);
                service::restart_service(&sys, role, &[me().to_string_lossy().into_owned()]);
            });
        }
        Action::Stop => {
            trace("stopping");
            std::thread::spawn(move || {
                let proc = RealProc;
                let sys = Sys::new(&proc);
                service::quit(&sys, role, pid);
            });
        }
        Action::Update => {
            let v = with(|st| if let Update::Available(v) = &st.extra.update { v.clone() } else { String::new() }).unwrap_or_default();
            trace(&format!("updating to {v}"));
            with(|st| st.extra.update = Update::Updating(v));
            let _ = std::process::Command::new(me()).args(["update", "--background"]).creation_flags(NO_WINDOW).spawn();
        }
        Action::Check => {
            with(|st| st.extra.checks = Checks::Running);
            run_checks(target);
        }
        Action::Quit => {
            trace("quitting the engine");
            unsafe { ShowWindow(hwnd, SW_HIDE) };
            // the task, the engine and the tunnel it started, as Restart stops them
            let proc = RealProc;
            let sys = Sys::new(&proc);
            service::quit(&sys, role, pid);
            unsafe { DestroyWindow(hwnd) };
            return;
        }
        Action::Tab(t) => {
            with(|st| st.tab = t);
        }
    }
    refresh(hwnd);
}

unsafe extern "system" fn proc_(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_CREATE => {
            let instance = unsafe { GetModuleHandleW(null()) };
            let buttons: Vec<(Id, HWND)> = BUTTONS
                .iter()
                .enumerate()
                .map(|(i, id)| {
                    let b = unsafe {
                        CreateWindowExW(
                            0,
                            wide("BUTTON").as_ptr(),
                            wide("").as_ptr(),
                            WS_CHILD | WS_TABSTOP | BS_OWNERDRAW as u32,
                            0,
                            0,
                            10,
                            10,
                            hwnd,
                            (FIRST_ID + i) as *mut _,
                            instance,
                            null(),
                        )
                    };
                    (*id, b)
                })
                .collect();
            with(|st| st.buttons = buttons);
            place_buttons();
            refresh(hwnd);
            0
        }
        // everything is painted in one go from a buffer, so nothing flickers
        WM_ERASEBKGND => 1,
        WM_COMMAND => {
            let n = wparam & 0xffff;
            if n == IDCANCEL as usize {
                // Esc closes the window, as its close button does
                unsafe { PostMessageW(hwnd, WM_CLOSE, 0, 0) };
            } else if let Some(id) = n.checked_sub(FIRST_ID).and_then(|i| BUTTONS.get(i)) {
                let action = with(|st| st.view.as_ref().and_then(|v| v.button(*id)).filter(|b| b.enabled).map(|b| b.action)).flatten();
                if let Some(a) = action {
                    act(hwnd, a);
                }
            }
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
            let tick = unsafe { Box::from_raw(lparam as *mut Tick) };
            let Tick { status, reach, update } = *tick;
            let now = crate::state::now_ms();
            let offer = with(|st| {
                if st.pairing.watch(&status, now) {
                    trace(&format!("the code ended: {:?}", st.pairing.card));
                }
                st.extra.reach = reach;
                if let (Update::Updating(_), Some(line)) = (&st.extra.update, &update) {
                    if let Some(v) = line.strip_prefix("done ") {
                        st.extra.update = Update::Done(v.to_string());
                    } else if line.starts_with("failed") {
                        trace(&format!("the update {line}"));
                        st.extra.update = Update::Failed;
                    }
                }
                // opened with no phone paired yet: the code is the one thing to do, so show it
                let running = status.link_running();
                let offer = st.role == Role::Link && !st.offered && running && status.phones.is_empty() && st.pairing == Pairing::default();
                if offer {
                    st.offered = true;
                }
                st.status = Some(status);
                offer
            })
            .unwrap_or(false);
            refresh(hwnd);
            if offer {
                start_pairing(hwnd);
            }
            0
        }
        PAIRED => {
            // SAFETY: as above, from the pairing thread
            let answer = unsafe { Box::from_raw(lparam as *mut (u32, Value)) };
            let (n, v) = *answer;
            with(|st| {
                if n == st.asked {
                    st.pairing.answer(v);
                    trace(&format!("pairing: {:?}", st.pairing.card));
                }
            });
            refresh(hwnd);
            0
        }
        FOUND => {
            // SAFETY: as above
            let found = unsafe { Box::from_raw(lparam as *mut Found) };
            with(|st| match *found {
                Found::Agents(a) => st.extra.agents = a,
                Found::Update(u) => {
                    if !matches!(st.extra.update, Update::Updating(_)) {
                        st.extra.update = u;
                    }
                }
                Found::Checks(c) => st.extra.checks = c,
            });
            refresh(hwnd);
            0
        }
        PAIR_NOW => {
            start_pairing(hwnd);
            0
        }
        WM_TIMER if wparam == DEMO_TICK => {
            demo_read(hwnd);
            0
        }
        WM_TIMER => {
            // a code past its ten minutes ends on time, and its last minute counts down
            let code = with(|st| {
                let shown = matches!(st.pairing.card, Card::Code { .. });
                if let Some(s) = st.status.as_ref().filter(|_| shown) {
                    if st.pairing.watch(s, crate::state::now_ms()) {
                        trace(&format!("the code ended: {:?}", st.pairing.card));
                    }
                }
                shown
            })
            .unwrap_or(false);
            // a Forget whose Undo ran out goes to the engine; the countdown is redrawn meanwhile
            let demo = with(|st| st.demo.is_some()).unwrap_or(false);
            let due = with(|st| match &st.extra.forgetting {
                Some((key, until)) if crate::state::now_ms() >= *until => {
                    let key = key.clone();
                    st.extra.forgetting = None;
                    Some(Some(key))
                }
                Some(_) => Some(None),
                None => None,
            })
            .flatten();
            match due {
                Some(Some(key)) if demo => {
                    trace(&format!("demo: would forget {key}"));
                    refresh(hwnd);
                }
                Some(Some(key)) => {
                    std::thread::spawn(move || match crate::commands::forget(&key) {
                        Ok(v) => trace(v.get("message").and_then(Value::as_str).unwrap_or("forgot the phone")),
                        Err(e) => trace(&format!("couldn't forget the phone: {e}")),
                    });
                    refresh(hwnd);
                }
                Some(None) => refresh(hwnd),
                None if code => refresh(hwnd),
                None => {}
            }
            0
        }
        WM_GETDPISCALEDSIZE => {
            // asked before a scale change: the size the layout gives at the new scale, so the
            // rectangle WM_DPICHANGED suggests is already the right one
            let dpi = wparam as u32;
            let forced = with(|st| st.demo.as_ref().map(|d| (d.dpi, d.work))).flatten();
            if forced.is_some_and(|(d, _)| d.is_some()) {
                return 0;
            }
            let monitor = unsafe {
                let own = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                let (mut x, mut y) = (96u32, 96u32);
                if GetDpiForMonitor(own, MDT_EFFECTIVE_DPI, &mut x, &mut y) == 0 && x == dpi {
                    own
                } else {
                    // dragged onto another monitor: the one the pointer is on
                    let mut at = POINT { x: 0, y: 0 };
                    GetCursorPos(&mut at);
                    MonitorFromPoint(at, MONITOR_DEFAULTTONEAREST)
                }
            };
            let frame = frame_for(dpi);
            let (w, h) = layout(dpi, work_for(monitor, forced.and_then(|f| f.1)), frame).outer(frame);
            // SAFETY: lparam is the SIZE to fill in with this message
            unsafe { *(lparam as *mut SIZE) = SIZE { cx: w, cy: h } };
            1
        }
        WM_DPICHANGED => {
            // moved to a monitor with another scale, or the scale changed: the suggested rectangle,
            // with the layout's size for that scale and monitor (the same unless Windows ignored
            // WM_GETDPISCALEDSIZE)
            let dpi = ((wparam >> 16) & 0xffff) as u32;
            // SAFETY: lparam is the suggested RECT with this message
            let suggested = unsafe { *(lparam as *const RECT) };
            let forced = with(|st| st.demo.as_ref().map(|d| (d.dpi, d.work))).flatten();
            let work = work_for(unsafe { MonitorFromRect(&suggested, MONITOR_DEFAULTTONEAREST) }, forced.and_then(|f| f.1));
            let dpi_used = forced.and_then(|f| f.0).unwrap_or(dpi);
            trace(&format!(
                "the scale is now {}%; suggested {},{} {}x{}",
                dpi * 100 / 96,
                suggested.left,
                suggested.top,
                suggested.right - suggested.left,
                suggested.bottom - suggested.top
            ));
            apply_layout(hwnd, dpi_used, dpi, work, Some((suggested.left, suggested.top)));
            0
        }
        WM_SIZE => {
            // the window never resizes itself: say so in the log if anything else did
            let (w, h) = ((lparam & 0xffff) as i32, ((lparam >> 16) & 0xffff) as i32);
            let expected = with(|st| st.layout.client).unwrap_or((w, h));
            if (w, h) != expected && unsafe { IsIconic(hwnd) } == 0 && w > 0 {
                trace(&format!("the client area became {w}x{h}; the layout is {}x{}", expected.0, expected.1));
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_SETTINGCHANGE => {
            // the app theme changed in Settings
            let what = if lparam == 0 { String::new() } else { unsafe { wide_str(lparam as *const u16) } };
            if what == "ImmersiveColorSet" {
                let dark = dark_mode();
                with(|st| {
                    st.palette = if dark { DARK } else { LIGHT };
                    st.repaint = true;
                });
                title_bar(hwnd, dark);
                refresh(hwnd);
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_PAINT => {
            paint(hwnd);
            0
        }
        WM_DESTROY => {
            STATE.with(|s| {
                if let Some(st) = s.borrow_mut().take() {
                    st.fonts.delete();
                }
            });
            unsafe { PostQuitMessage(0) };
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// A NUL-terminated UTF-16 string.
unsafe fn wide_str(p: *const u16) -> String {
    let mut n = 0;
    unsafe {
        while *p.add(n) != 0 && n < 256 {
            n += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(p, n))
    }
}

fn rect(r: Rect) -> RECT {
    RECT { left: r.x, top: r.y, right: r.right(), bottom: r.bottom() }
}

/// One line in `r`, cut with an ellipsis if it doesn't fit.
unsafe fn line(hdc: HDC, font: HFONT, color: u32, s: &str, r: Rect, flags: u32) {
    unsafe {
        SelectObject(hdc, font as HGDIOBJ);
        SetTextColor(hdc, cref(color));
        let mut w = wide(s);
        let mut rr = rect(r);
        DrawTextW(hdc, w.as_mut_ptr(), -1, &mut rr, flags | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX);
    }
}

/// How wide `s` is in `font`.
unsafe fn width_of(hdc: HDC, font: HFONT, s: &str) -> i32 {
    unsafe {
        SelectObject(hdc, font as HGDIOBJ);
        let w: Vec<u16> = s.encode_utf16().collect();
        let mut size = SIZE { cx: 0, cy: 0 };
        GetTextExtentPoint32W(hdc, w.as_ptr(), w.len() as i32, &mut size);
        size.cx
    }
}

/// `s` wrapped into as many lines of `line_h` as fit in `r`, the last cut with an ellipsis.
unsafe fn lines(hdc: HDC, font: HFONT, color: u32, s: &str, r: Rect, line_h: i32) {
    let measure = |t: &str| unsafe { width_of(hdc, font, t) };
    let rows = (r.h / line_h).max(1) as usize;
    for (i, l) in fit_lines(s, r.w, rows, &measure).iter().enumerate() {
        unsafe { line(hdc, font, color, l, Rect::new(r.x, r.y + i as i32 * line_h, r.w, line_h), DT_LEFT) };
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

/// A rounded rectangle, filled with `fill` and edged with `edge` (#RRGGBB; None leaves it out),
/// the edge dashed when asked.
unsafe fn rounded(g: *mut GpGraphics, r: Rect, radius: i32, fill: Option<u32>, edge: Option<u32>, dashed: bool, width: f32) {
    unsafe {
        let mut path: *mut GpPath = null_mut();
        GdipCreatePath(FillModeAlternate, &mut path);
        let d = (radius * 2).clamp(1, r.h.min(r.w) - 1);
        let (x, y, w, h) = (r.x, r.y, r.w - 1, r.h - 1);
        GdipAddPathArcI(path, x, y, d, d, 180.0, 90.0);
        GdipAddPathArcI(path, x + w - d, y, d, d, 270.0, 90.0);
        GdipAddPathArcI(path, x + w - d, y + h - d, d, d, 0.0, 90.0);
        GdipAddPathArcI(path, x, y + h - d, d, d, 90.0, 90.0);
        GdipClosePathFigure(path);
        if let Some(fill) = fill {
            let mut brush: *mut GpSolidFill = null_mut();
            GdipCreateSolidFill(argb(fill), &mut brush);
            GdipFillPath(g, brush as *mut GpBrush, path);
            GdipDeleteBrush(brush as *mut GpBrush);
        }
        if let Some(edge) = edge {
            let mut pen: *mut GpPen = null_mut();
            GdipCreatePen1(argb(edge), width, UnitPixel, &mut pen);
            if dashed {
                GdipSetPenDashStyle(pen, DashStyleDash);
            }
            GdipDrawPath(g, pen, path);
            GdipDeletePen(pen);
        }
        GdipDeletePath(path);
    }
}

/// A dot: filled, a ring, or filled in the attention colour.
unsafe fn dot(g: *mut GpGraphics, x: i32, y: i32, d: i32, kind: Dot, p: &Palette, on: u32) {
    unsafe {
        match kind {
            Dot::On | Dot::Attention => {
                let mut brush: *mut GpSolidFill = null_mut();
                GdipCreateSolidFill(argb(if kind == Dot::On { on } else { p.warn }), &mut brush);
                GdipFillEllipseI(g, brush as *mut GpBrush, x, y, d, d);
                GdipDeleteBrush(brush as *mut GpBrush);
            }
            Dot::Off => {
                let mut pen: *mut GpPen = null_mut();
                GdipCreatePen1(argb(p.fg3), 1.5, UnitPixel, &mut pen);
                GdipDrawEllipseI(g, pen, x, y, d - 1, d - 1);
                GdipDeletePen(pen);
            }
        }
    }
}

unsafe fn stroke(g: *mut GpGraphics, color: u32, width: f32, pts: &[(i32, i32)]) {
    unsafe {
        let mut pen: *mut GpPen = null_mut();
        GdipCreatePen1(argb(color), width, UnitPixel, &mut pen);
        for w in pts.windows(2) {
            GdipDrawLineI(g, pen, w[0].0, w[0].1, w[1].0, w[1].1);
        }
        GdipDeletePen(pen);
    }
}

/// What fills the code square when there's no code: a dashed outline and a small sign.
unsafe fn glyph(g: *mut GpGraphics, r: Rect, kind: Glyph, p: &Palette, k: f32) {
    let s = |v: f32| (v * k) as i32;
    let (cx, cy) = (r.x + r.w / 2, r.y + r.h / 2);
    unsafe {
        rounded(g, r, s(8.0), None, Some(p.line_strong), kind != Glyph::Done, 1.0);
        match kind {
            Glyph::Idle => rounded(g, Rect::new(cx - s(8.0), cy - s(13.0), s(16.0), s(26.0)), s(3.0), None, Some(p.fg3), false, 1.5 * k),
            Glyph::Wait => {
                for i in -1..=1 {
                    dot(g, cx + i * s(9.0) - s(3.0), cy - s(3.0), s(6.0), Dot::On, p, p.fg3);
                }
            }
            Glyph::Done => stroke(g, p.fg, 2.0 * k, &[(cx - s(10.0), cy), (cx - s(3.0), cy + s(7.0)), (cx + s(11.0), cy - s(8.0))]),
            Glyph::Error => {
                let mut pen: *mut GpPen = null_mut();
                GdipCreatePen1(argb(p.danger), 1.6 * k, UnitPixel, &mut pen);
                GdipDrawEllipseI(g, pen, cx - s(13.0), cy - s(13.0), s(26.0), s(26.0));
                GdipDeletePen(pen);
                stroke(g, p.danger, 1.8 * k, &[(cx, cy - s(7.0)), (cx, cy + s(2.0))]);
                dot(g, cx - s(1.5), cy + s(5.0), s(3.0), Dot::On, p, p.danger);
            }
            Glyph::Hub => {
                rounded(g, Rect::new(cx - s(16.0), cy - s(13.0), s(32.0), s(11.0)), s(3.0), None, Some(p.fg3), false, 1.5 * k);
                rounded(g, Rect::new(cx - s(16.0), cy + s(2.0), s(32.0), s(11.0)), s(3.0), None, Some(p.fg3), false, 1.5 * k);
            }
            Glyph::Qr => {}
        }
    }
}

/// The buttons, drawn by the window: the primary filled with ink, the footer's as quiet text,
/// the tabs as a segmented row, the others on the card with a hairline.
fn draw_button(item: &DRAWITEMSTRUCT) {
    let Some(i) = (item.CtlID as usize).checked_sub(FIRST_ID) else { return };
    let Some(id) = BUTTONS.get(i).copied() else { return };
    let Some((p, fonts, dpi, b, tab)) = with(|st| {
        let b = st.view.as_ref().and_then(|v| v.button(id).cloned());
        (st.palette, (st.fonts.body, st.fonts.small, st.fonts.strong), st.dpi, b, st.tab)
    }) else {
        return;
    };
    let k = dpi as f32 / 96.0;
    let hdc = item.hDC;
    let r = item.rcItem;
    let r = Rect::new(r.left, r.top, r.right - r.left, r.bottom - r.top);
    let pressed = item.itemState & ODS_SELECTED != 0;
    // the ring shows once the keyboard is used, not after a click
    let focused = item.itemState & ODS_FOCUS != 0 && item.itemState & ODS_NOFOCUSRECT == 0;
    let behind = if id.card().is_some() { p.panel } else { p.ground };
    unsafe {
        let brush = CreateSolidBrush(cref(behind));
        FillRect(hdc, &rect(r), brush);
        DeleteObject(brush as HGDIOBJ);
        let Some(b) = b else { return };
        let enabled = b.enabled;
        let (fill, edge, ink, font) = match id {
            Id::Primary => (Some(if pressed { p.accent_pressed } else { p.accent }), None, p.accent_fg, fonts.0),
            Id::Tab(t) if t == tab => (Some(p.panel), Some(p.line_strong), p.fg, fonts.2),
            Id::Tab(_) => (Some(if pressed { p.pressed } else { p.raised }), Some(p.line), p.fg2, fonts.0),
            Id::OpenLog | Id::Quit => (pressed.then_some(p.pressed), None, p.fg2, fonts.1),
            Id::Secondary => (Some(if pressed { p.pressed } else { p.panel }), Some(p.line), p.fg, fonts.0),
            _ => (Some(if pressed { p.pressed } else { p.raised }), Some(p.line), p.fg, fonts.1),
        };
        let ink = if enabled { ink } else { p.fg3 };
        let fill = if enabled || id != Id::Primary { fill } else { Some(p.line_strong) };
        let g = canvas(hdc);
        let radius = if matches!(id, Id::Primary | Id::Secondary | Id::Tab(_)) { 8.0 } else { 6.0 };
        rounded(g, r, (radius * k) as i32, fill, edge, false, 1.0);
        if focused {
            rounded(g, r, (radius * k) as i32, None, Some(p.fg), false, 2.0 * k);
        }
        GdipDeleteGraphics(g);
        SetBkMode(hdc, TRANSPARENT as i32);
        let pad = (6.0 * k) as i32;
        line(hdc, font, ink, &b.label, Rect::new(r.x + pad, r.y, r.w - 2 * pad, r.h), DT_CENTER);
    }
}

fn paint(hwnd: HWND) {
    unsafe {
        let mut ps: PAINTSTRUCT = std::mem::zeroed();
        let screen = BeginPaint(hwnd, &mut ps);
        STATE.with(|s| {
            let st = s.borrow();
            let Some(st) = st.as_ref() else { return };
            let (w, h) = st.layout.client;
            // drawn off screen first, then copied in one go
            let hdc = CreateCompatibleDC(screen);
            let bitmap = CreateCompatibleBitmap(screen, w, h);
            let old = SelectObject(hdc, bitmap as HGDIOBJ);
            draw(hdc, st);
            BitBlt(screen, 0, 0, w, h, hdc, 0, 0, SRCCOPY);
            SelectObject(hdc, old);
            DeleteObject(bitmap as HGDIOBJ);
            DeleteDC(hdc);
        });
        EndPaint(hwnd, &ps);
    }
}

unsafe fn draw(hdc: HDC, st: &State) {
    let p = st.palette;
    let l = &st.layout;
    let f = &st.fonts;
    let k = st.dpi as f32 / 96.0;
    let s = |v: f32| (v * k) as i32;
    let at = |id: Id| l.get(id);
    let shown = |id: Id| l.shown(id, st.tab);
    unsafe {
        let ground = CreateSolidBrush(cref(p.ground));
        FillRect(hdc, &RECT { left: 0, top: 0, right: l.client.0, bottom: l.client.1 }, ground);
        DeleteObject(ground as HGDIOBJ);
        SetBkMode(hdc, TRANSPARENT as i32);
        let g = canvas(hdc);
        if !st.mark.is_null() {
            let m = at(Id::Mark);
            GdipDrawImageRectI(g, st.mark, m.x, m.y, m.w, m.h);
        }
        let v = st.view.as_ref();
        // the pill, then the cards on this tab
        let pill = at(Id::Pill);
        rounded(g, pill, pill.h / 2, Some(p.panel), Some(p.line), false, 1.0);
        let (pill_text, pill_dot) = v.map(|v| v.pill.clone()).unwrap_or(("Looking…".to_string(), Dot::Off));
        let tw = width_of(hdc, f.strong, &pill_text);
        let d = s(8.0);
        let x0 = pill.x + (pill.w - (d + s(8.0) + tw)) / 2;
        dot(g, x0, pill.y + (pill.h - d) / 2, d, pill_dot, &p, p.fg);
        for card in [Id::PairCard, Id::LinkCard, Id::PhonesCard, Id::CompCard] {
            if shown(card) && v.is_some() {
                rounded(g, at(card), s(12.0), Some(p.panel), Some(p.line), false, 1.0);
            }
        }
        if let Some(v) = v {
            if shown(Id::Qr) {
                let q = at(Id::Qr);
                let code = v.qr.as_deref().and_then(|t| QrCode::with_error_correction_level(t.as_bytes(), EcLevel::L).ok());
                match code {
                    Some(_) => rounded(g, q, s(8.0), Some(0xffffff), Some(p.line), false, 1.0),
                    None => glyph(g, q, v.glyph, &p, k),
                }
            }
            if shown(Id::Lan) {
                if let Some((lan, vpn, tunnel)) = v.reach {
                    for (id, on) in [(Id::Lan, lan), (Id::Vpn, vpn), (Id::Tunnel, tunnel)] {
                        let c = at(id);
                        rounded(g, c, c.h / 2, None, Some(if on { p.line_strong } else { p.line }), false, 1.0);
                        dot(g, c.x + s(9.0), c.y + (c.h - s(6.0)) / 2, s(6.0), if on { Dot::On } else { Dot::Off }, &p, p.fg);
                    }
                }
            }
            for i in 0..4u8 {
                if shown(Id::CompText(i)) && v.comp[i as usize].1 {
                    let r = at(Id::CompText(i));
                    dot(g, r.x, r.y + (r.h - s(7.0)) / 2, s(7.0), Dot::Attention, &p, p.fg);
                }
            }
        }
        GdipDeleteGraphics(g);

        // the text, with GDI
        line(hdc, f.title, p.fg, "Inyon", at(Id::Title), DT_LEFT);
        line(hdc, f.small, p.fg3, v.map(|v| v.subtitle.as_str()).unwrap_or(crate::ui::VERSION), at(Id::Subtitle), DT_LEFT);
        line(hdc, f.strong, p.fg, &pill_text, Rect::new(x0 + d + s(8.0), pill.y, tw + s(2.0), pill.h), DT_LEFT);
        let Some(v) = v else { return };
        if shown(Id::PairCard) {
            line(hdc, f.strong, p.fg, &v.card_title, at(Id::PairTitle), DT_LEFT);
            let side = at(Id::Side);
            let line_h = s(18.0);
            let code_h = if v.code.is_some() { s(18.0) + 2 * s(24.0) } else { 0 };
            lines(
                hdc,
                if v.side_strong { f.strong } else { f.body },
                if v.side_strong { p.fg } else { p.fg2 },
                &v.side,
                Rect::new(side.x, side.y, side.w, side.h - code_h),
                line_h,
            );
            if let Some((id, pin)) = &v.code {
                let y = side.bottom() - code_h;
                line(hdc, f.small, p.fg3, "Or type it in the app", Rect::new(side.x, y, side.w, s(18.0)), DT_LEFT);
                for (n, (label, value)) in [("ID", id), ("Code", pin)].iter().enumerate() {
                    let row = Rect::new(side.x, y + s(18.0) + n as i32 * s(24.0), side.w, s(24.0));
                    line(hdc, f.small, p.fg3, label, Rect::new(row.x, row.y, s(44.0), row.h), DT_LEFT);
                    line(hdc, f.code, p.fg, value, Rect::new(row.x + s(44.0), row.y, row.w - s(44.0), row.h), DT_LEFT);
                }
            }
            lines(hdc, f.small, p.fg3, &v.note, at(Id::Note), s(18.0));
            // the code itself, crisp: whole pixels per module, with a quiet zone of two
            if let Some(code) = v.qr.as_deref().and_then(|t| QrCode::with_error_correction_level(t.as_bytes(), EcLevel::L).ok()) {
                let q = at(Id::Qr);
                let n = code.width() as i32;
                let module = (q.w.min(q.h) / (n + 4)).max(1);
                let (ox, oy) = (q.x + (q.w - module * n) / 2, q.y + (q.h - module * n) / 2);
                let ink = CreateSolidBrush(cref(0x1d1c1a));
                for (i, c) in code.to_colors().iter().enumerate() {
                    if *c == Color::Dark {
                        let (x, y) = ((i as i32) % n, (i as i32) / n);
                        FillRect(hdc, &RECT { left: ox + x * module, top: oy + y * module, right: ox + (x + 1) * module, bottom: oy + (y + 1) * module }, ink);
                    }
                }
                DeleteObject(ink as HGDIOBJ);
            }
        }
        if shown(Id::LinkCard) {
            line(hdc, f.small, p.fg3, &v.reach_label, at(Id::ReachLabel), DT_LEFT);
            if let Some((lan, vpn, tunnel)) = v.reach {
                for (id, name, on) in [(Id::Lan, "LAN", lan), (Id::Vpn, "VPN", vpn), (Id::Tunnel, "Tunnel", tunnel)] {
                    let c = at(id);
                    line(hdc, if on { f.small } else { f.strike }, if on { p.fg } else { p.fg3 }, name, Rect::new(c.x + s(19.0), c.y, c.w - s(23.0), c.h), DT_LEFT);
                }
            }
            line(hdc, f.body, p.fg2, &v.link_detail, at(Id::LinkDetail), DT_LEFT);
        }
        if shown(Id::PhonesCard) {
            line(hdc, f.strong, p.fg, &v.phones_title, at(Id::PhonesTitle), DT_LEFT);
            for (i, (name, seen)) in v.phones.iter().enumerate().take(super::layout::PHONE_ROWS) {
                let i = i as u8;
                let full = seen.is_empty();
                let name_box = if full {
                    Rect::new(at(Id::PhoneName(i)).x, at(Id::PhoneName(i)).y, at(Id::Forget(i)).right() - at(Id::PhoneName(i)).x, at(Id::PhoneName(i)).h)
                } else {
                    at(Id::PhoneName(i))
                };
                line(hdc, f.body, if full { p.fg2 } else { p.fg }, name, name_box, DT_LEFT);
                line(hdc, f.small, p.fg2, seen, at(Id::PhoneSeen(i)), DT_LEFT);
            }
        }
        if shown(Id::CompCard) {
            for i in 0..4u8 {
                let (text, attention) = &v.comp[i as usize];
                let mut r = at(Id::CompText(i));
                if *attention {
                    r = Rect::new(r.x + s(14.0), r.y, r.w - s(14.0), r.h);
                }
                line(hdc, f.body, if i == 0 || *attention { p.fg } else { p.fg2 }, text, r, DT_LEFT);
            }
        }
        line(hdc, f.log, p.fg3, &v.log, at(Id::Log), DT_LEFT);
    }
}
