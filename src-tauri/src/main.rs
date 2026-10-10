#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod win;

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, MutexGuard, OnceLock},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, WebviewWindowBuilder, Wry,
};
use windows::Win32::{Foundation::HWND, UI::Accessibility::HWINEVENTHOOK};

const SNOOZE_MS: i64 = 5 * 60_000;
/// Keep a compact (auto-hide) overlay full-size while the drink / snooze animation plays.
const ANIM_MS: i64 = 2_800;

static APP: OnceLock<AppHandle> = OnceLock::new();

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    interval_min: u32,
    theme: String,
    mode: String,
    opacity: f64,
    text: String,
    show_time: bool,
    sound: bool,
    autostart: bool,
    cups: u32,
    cups_date: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            interval_min: 45,
            theme: "ocean".into(),
            mode: "fill".into(),
            opacity: 0.7,
            text: "该喝水啦".into(),
            show_time: true,
            sound: true,
            autostart: false,
            cups: 0,
            cups_date: String::new(),
        }
    }
}

struct Core {
    s: Settings,
    path: PathBuf,
    cycle_start: i64,
    paused_at: Option<i64>,
    reminding: bool,
    action: &'static str,
    seq: u64,
    expand_until: i64,
    bar: Option<win::Bar>,
    compact: bool,
    hidden: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    settings: Settings,
    cycle_start: i64,
    interval_ms: i64,
    paused_at: Option<i64>,
    reminding: bool,
    action: &'static str,
    seq: u64,
    side: &'static str,
    compact: bool,
    /// The overlay is hidden (fullscreen app): WebView2 isn't told, so the page pauses itself.
    hidden: bool,
}

impl Core {
    fn interval_ms(&self) -> i64 {
        self.s.interval_min.max(1) as i64 * 60_000
    }
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            settings: self.s.clone(),
            cycle_start: self.cycle_start,
            interval_ms: self.interval_ms(),
            paused_at: self.paused_at,
            reminding: self.reminding,
            action: self.action,
            seq: self.seq,
            side: self.bar.map_or("bottom", |b| b.side),
            compact: self.compact,
            hidden: self.hidden,
        }
    }
    fn bump(&mut self, action: &'static str) {
        self.action = action;
        self.seq += 1;
    }
    fn restart(&mut self, now: i64) {
        self.cycle_start = now;
        self.paused_at = None;
        self.reminding = false;
    }
    /// Reset the cup counter on a new day. Returns true when it changed.
    fn roll_day(&mut self) -> bool {
        let today = win::today();
        if self.s.cups_date == today {
            return false;
        }
        self.s.cups_date = today;
        self.s.cups = 0;
        true
    }
    fn save(&self) {
        if let Some(dir) = self.path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(&self.s) {
            let _ = fs::write(&self.path, json);
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

fn core(app: &AppHandle) -> MutexGuard<'_, Core> {
    app.state::<Mutex<Core>>().inner().lock().unwrap_or_else(|e| e.into_inner())
}

fn publish(app: &AppHandle, c: &Core) {
    let _ = app.emit("state", c.snapshot());
}

/// Every user action (overlay click, tray menu, settings buttons) goes through here.
fn act(app: &AppHandle, what: &str) {
    let paused = {
        let mut c = core(app);
        let now = now_ms();
        match what {
            "drink" => {
                c.roll_day();
                c.s.cups += 1;
                c.restart(now);
                c.expand_until = now + ANIM_MS;
                c.save();
                c.bump("drink");
            }
            // Only a showing reminder can be snoozed; otherwise it would pull the reminder closer.
            "snooze" if c.reminding => {
                let iv = c.interval_ms();
                c.restart(now - (iv - SNOOZE_MS.min(iv / 2)));
                c.expand_until = now + ANIM_MS;
                c.bump("snooze");
            }
            "reset" => {
                c.restart(now);
                c.bump("reset");
            }
            "pause" => {
                match c.paused_at {
                    Some(p) => {
                        c.cycle_start += now - p;
                        c.paused_at = None;
                    }
                    None if !c.reminding => c.paused_at = Some(now),
                    None => {}
                }
                c.bump("pause");
            }
            // Make the cycle due now; the ticker raises the reminder like a real one.
            "test" => {
                let iv = c.interval_ms();
                c.restart(now - iv);
                c.bump("reset");
            }
            _ => return,
        }
        publish(app, &c);
        c.paused_at.is_some()
    };
    refresh_tray(app, paused);
    sync_later(app);
}

fn sync_later(app: &AppHandle) {
    let h = app.clone();
    let _ = app.run_on_main_thread(move || sync_overlay(&h));
}

/// Main-thread only: position, z-order, visibility and click-through of the overlay.
fn sync_overlay(app: &AppHandle) {
    let Some(w) = app.get_webview_window("overlay") else { return };
    let Ok(raw) = w.hwnd() else { return };
    let hwnd = HWND(raw.0 as _);
    // try_lock: the WinEvent hook can re-enter while the main thread already holds the lock
    // (e.g. a COM call inside emit pumps messages). Skipping is fine, the ticker retries in 250ms.
    let state = app.state::<Mutex<Core>>();
    let Ok(mut c) = state.try_lock() else { return };
    let Some(bar) = c.bar else { return };
    let expanded = c.reminding || now_ms() < c.expand_until;
    let (rc, compact) = win::overlay_rect(&bar, expanded, hwnd);
    let hidden = win::fullscreen_foreground(hwnd);
    win::place(hwnd, rc, !hidden, !c.reminding);
    if c.compact != compact || c.hidden != hidden {
        c.compact = compact;
        c.hidden = hidden;
        publish(app, &c);
    }
}

unsafe extern "system" fn on_foreground(_: HWINEVENTHOOK, _: u32, _: HWND, _: i32, _: i32, _: u32, _: u32) {
    if let Some(app) = APP.get() {
        sync_overlay(app);
    }
}

/// Background ticker: fires reminders, tracks the taskbar, keeps the tray tooltip fresh.
fn ticker(app: AppHandle) {
    let mut last = now_ms();
    let mut tip = String::new();
    loop {
        thread::sleep(Duration::from_millis(250));
        let now = now_ms();
        // Woke from sleep / hibernate: start a fresh cycle instead of nagging instantly.
        // A paused timer stays paused (its resume math already skips the sleep).
        let slept = now - last > 60_000;
        last = now;
        if slept && core(&app).paused_at.is_none() {
            act(&app, "reset");
        }
        let bar = win::taskbar(); // cross-process call: keep it off the UI thread
        let next = {
            let mut c = core(&app);
            let mut dirty = c.bar.map(|b| b.side) != bar.map(|b| b.side);
            if bar.is_some() {
                c.bar = bar;
            }
            if c.roll_day() {
                c.save();
                dirty = true;
            }
            if !c.reminding && c.paused_at.is_none() && now - c.cycle_start >= c.interval_ms() {
                c.reminding = true;
                c.bump("remind");
                dirty = true;
            }
            if dirty {
                publish(&app, &c);
            }
            tooltip(&c, now)
        };
        // Tray calls block until the main thread runs them, and the main thread may be waiting
        // for the Core lock (a command, a menu click): never call them while holding it.
        if next != tip {
            if let Some(t) = app.tray_by_id("main") {
                let _ = t.set_tooltip(Some(&next));
            }
            tip = next;
        }
        sync_later(&app);
    }
}

fn tooltip(c: &Core, now: i64) -> String {
    if c.reminding {
        return format!("喝水进度条 · {}！", c.s.text);
    }
    if c.paused_at.is_some() {
        return "喝水进度条 · 已暂停".into();
    }
    let left = (c.interval_ms() - (now - c.cycle_start)).max(0);
    format!("喝水进度条 · 还有 {} 分钟 · 今日 {} 杯", (left + 59_999) / 60_000, c.s.cups)
}

struct PauseItem(MenuItem<Wry>);

/// Must be called without the Core lock held (see the ticker).
fn refresh_tray(app: &AppHandle, paused: bool) {
    if let Some(item) = app.try_state::<PauseItem>() {
        let _ = item.0.set_text(if paused { "继续计时" } else { "暂停计时" });
    }
}

fn open_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.unminimize();
        let _ = w.show();
        // Windows' foreground lock ignores set_focus from a background app; a brief
        // always-on-top flip is the standard way to still raise the window.
        let _ = w.set_always_on_top(true);
        let _ = w.set_always_on_top(false);
        let _ = w.set_focus();
        return;
    }
    if let Some(cfg) = app.config().app.windows.iter().find(|w| w.label == "settings") {
        let _ = WebviewWindowBuilder::from_config(app, cfg).and_then(|b| b.build());
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let pause = MenuItem::with_id(app, "pause", "暂停计时", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", "打开设置", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "drink", "我喝完了，重新计时", true, None::<&str>)?,
            &MenuItem::with_id(app, "snooze", "稍后提醒（5 分钟）", true, None::<&str>)?,
            &pause,
            &MenuItem::with_id(app, "test", "预览提醒效果", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?,
        ],
    )?;
    app.manage(PauseItem(pause));
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("bundle icon"))
        .tooltip("喝水进度条")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "open" => open_settings(app),
            "quit" => app.exit(0),
            other => act(app, other),
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                open_settings(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[tauri::command]
fn get_state(app: AppHandle) -> Snapshot {
    core(&app).snapshot()
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Snapshot {
    let snap = {
        let mut c = core(&app);
        let autostart_changed = c.s.autostart != settings.autostart;
        let (cups, cups_date) = (c.s.cups, c.s.cups_date.clone());
        // Values come from a webview: clamp them, the counters stay backend-owned.
        c.s = Settings {
            interval_min: settings.interval_min.clamp(1, 600),
            opacity: settings.opacity.clamp(0.15, 1.0),
            text: settings.text.trim().chars().take(16).collect(),
            cups,
            cups_date,
            ..settings
        };
        if c.s.text.is_empty() {
            c.s.text = Settings::default().text;
        }
        if autostart_changed {
            win::set_autostart(c.s.autostart);
        }
        // Scrubbing the interval slider down and back up must not leave a reminder behind.
        if c.reminding && now_ms() - c.cycle_start < c.interval_ms() {
            c.reminding = false;
        }
        c.save();
        c.bump("settings");
        publish(&app, &c);
        c.snapshot()
    };
    sync_later(&app);
    snap
}

#[tauri::command]
fn action(app: AppHandle, what: String) -> Snapshot {
    act(&app, &what);
    core(&app).snapshot()
}

fn main() {
    tauri::Builder::default()
        // A second launch opens the settings; `WaterBar.exe --preview` shows the reminder right away.
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if args.iter().any(|a| a == "--preview") {
                act(app, "test");
            } else {
                open_settings(app);
            }
        }))
        .invoke_handler(tauri::generate_handler![get_state, save_settings, action])
        .setup(|app| {
            let handle = app.handle().clone();
            let path = app.path().app_config_dir()?.join("settings.json");
            let first_run = !path.exists();
            let s: Settings = fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
            if s.autostart {
                win::set_autostart(true); // refresh the path in case the exe moved
            }
            let mut c = Core {
                s,
                path,
                cycle_start: now_ms(),
                paused_at: None,
                reminding: false,
                action: "init",
                seq: 0,
                expand_until: 0,
                bar: win::taskbar(),
                compact: false,
                hidden: false,
            };
            c.roll_day();
            app.manage(Mutex::new(c));
            let _ = APP.set(handle.clone());

            sync_overlay(&handle);
            build_tray(&handle)?;
            win::on_foreground_change(on_foreground);
            let h = handle.clone();
            thread::spawn(move || ticker(h));

            if first_run || !std::env::args().any(|a| a == "--autostart") {
                open_settings(&handle);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build WaterBar")
        .run(|_, e| {
            if let RunEvent::ExitRequested { code: None, api, .. } = e {
                api.prevent_exit(); // closing the settings window must not quit the tray app
            }
        });
}
