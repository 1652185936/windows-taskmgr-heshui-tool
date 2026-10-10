//! Thin Win32 helpers: taskbar geometry, z-order, fullscreen detection, autostart.

use std::mem::size_of;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, RECT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromRect, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::System::Registry::{RegDeleteKeyValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};
use windows::Win32::System::SystemInformation::GetLocalTime;
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Shell::{SHAppBarMessage, ABE_LEFT, ABE_RIGHT, ABE_TOP, ABM_GETSTATE, ABM_GETTASKBARPOS, ABS_AUTOHIDE, APPBARDATA};
use windows::Win32::UI::WindowsAndMessaging::*;

/// Primary taskbar geometry in physical pixels.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Bar {
    pub rc: RECT,
    pub monitor: RECT,
    pub side: &'static str,
    pub autohide: bool,
}

pub fn taskbar() -> Option<Bar> {
    unsafe {
        let mut abd = APPBARDATA { cbSize: size_of::<APPBARDATA>() as u32, ..Default::default() };
        if SHAppBarMessage(ABM_GETTASKBARPOS, &mut abd) == 0 {
            return None;
        }
        let state = SHAppBarMessage(ABM_GETSTATE, &mut APPBARDATA { cbSize: abd.cbSize, ..Default::default() });
        let side = match abd.uEdge {
            ABE_LEFT => "left",
            ABE_TOP => "top",
            ABE_RIGHT => "right",
            _ => "bottom",
        };
        let mut mi = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        let _ = GetMonitorInfoW(MonitorFromRect(&abd.rc, MONITOR_DEFAULTTOPRIMARY), &mut mi);
        Some(Bar { rc: abd.rc, monitor: mi.rcMonitor, side, autohide: state as u32 & ABS_AUTOHIDE != 0 })
    }
}

/// Where the overlay goes. An auto-hidden taskbar gets a thin strip at the screen edge
/// (so we never cover app content) unless `expanded` (reminder showing).
pub fn overlay_rect(bar: &Bar, expanded: bool, hwnd: HWND) -> (RECT, bool) {
    if !bar.autohide {
        return (bar.rc, false);
    }
    let m = bar.monitor;
    let horizontal = matches!(bar.side, "top" | "bottom");
    let full = if horizontal { bar.rc.bottom - bar.rc.top } else { bar.rc.right - bar.rc.left };
    let strip = (5.0 * unsafe { GetDpiForWindow(hwnd) }.max(96) as f64 / 96.0).round() as i32;
    let t = if expanded { full } else { strip };
    let rc = match bar.side {
        "top" => RECT { bottom: m.top + t, ..m },
        "left" => RECT { right: m.left + t, ..m },
        "right" => RECT { left: m.right - t, ..m },
        _ => RECT { top: m.bottom - t, ..m },
    };
    (rc, !expanded)
}

/// Move/show/hide the overlay, keep it above the taskbar without stealing focus, and set
/// click-through. All done here with Win32 on purpose: tao rewrites the whole ex-style (and hides
/// the window, since it never saw it shown) whenever one of its own window flags changes.
pub fn place(hwnd: HWND, rc: RECT, show: bool, click_through: bool) {
    unsafe {
        let visible = IsWindowVisible(hwnd).as_bool();
        if !show {
            if visible {
                let _ = ShowWindow(hwnd, SW_HIDE);
            }
            return;
        }
        // LAYERED stays on; TRANSPARENT on top of it lets clicks fall through to the taskbar.
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let mut want = ex | (WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0 | WS_EX_LAYERED.0) as isize;
        if click_through {
            want |= WS_EX_TRANSPARENT.0 as isize;
        } else {
            want &= !(WS_EX_TRANSPARENT.0 as isize);
        }
        if ex != want {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
            if ex & WS_EX_LAYERED.0 as isize == 0 {
                let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA);
            }
        }
        let mut cur = RECT::default();
        let _ = GetWindowRect(hwnd, &mut cur);
        if cur != rc || taskbar_above(hwnd) {
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top, SWP_NOACTIVATE | SWP_NOOWNERZORDER);
        }
        if !visible {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
    }
}

/// True when the taskbar sits above us in z-order (user clicked it, explorer raised it).
fn taskbar_above(hwnd: HWND) -> bool {
    unsafe {
        let Ok(tray) = FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()) else { return false };
        let mut h = hwnd;
        for _ in 0..256 {
            match GetWindow(h, GW_HWNDPREV) {
                Ok(prev) if !prev.is_invalid() => {
                    if prev == tray {
                        return true;
                    }
                    h = prev;
                }
                _ => return false,
            }
        }
        false
    }
}

/// A game / video / slideshow covers the whole monitor: get out of the way.
pub fn fullscreen_foreground(own: HWND) -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.is_invalid() || fg == own {
            return false;
        }
        let mut buf = [0u16; 64];
        let n = GetClassNameW(fg, &mut buf) as usize;
        let class = String::from_utf16_lossy(&buf[..n]);
        if matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd") {
            return false;
        }
        // A maximized window also covers the monitor when the taskbar auto-hides; real
        // fullscreen (games, F11, video) is neither zoomed nor has a caption.
        let style = GetWindowLongPtrW(fg, GWL_STYLE) as u32;
        if IsZoomed(fg).as_bool() || style & WS_CAPTION.0 == WS_CAPTION.0 {
            return false;
        }
        let mut r = RECT::default();
        if GetWindowRect(fg, &mut r).is_err() {
            return false;
        }
        let mut mi = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST), &mut mi).as_bool() {
            return false;
        }
        let m = mi.rcMonitor;
        mi.dwFlags & MONITORINFOF_PRIMARY != 0 && r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom
    }
}

pub type HookFn = unsafe extern "system" fn(HWINEVENTHOOK, u32, HWND, i32, i32, u32, u32);

/// Fires `cb` on the calling thread's message loop whenever the foreground window changes.
pub fn on_foreground_change(cb: HookFn) {
    unsafe {
        SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, None, Some(cb), 0, 0, WINEVENT_OUTOFCONTEXT);
    }
}

const RUN_KEY: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
const RUN_NAME: PCWSTR = w!("WaterBar");

pub fn set_autostart(on: bool) {
    unsafe {
        if !on {
            let _ = RegDeleteKeyValueW(HKEY_CURRENT_USER, RUN_KEY, RUN_NAME);
            return;
        }
        let Ok(exe) = std::env::current_exe() else { return };
        let cmd: Vec<u16> = format!("\"{}\" --autostart", exe.display()).encode_utf16().chain([0]).collect();
        let _ = RegSetKeyValueW(HKEY_CURRENT_USER, RUN_KEY, RUN_NAME, REG_SZ.0, Some(cmd.as_ptr().cast()), (cmd.len() * 2) as u32);
    }
}

/// Local calendar day, used to reset the cup counter at midnight.
pub fn today() -> String {
    let t = unsafe { GetLocalTime() };
    format!("{:04}-{:02}-{:02}", t.wYear, t.wMonth, t.wDay)
}
