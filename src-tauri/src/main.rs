#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod win;

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{mpsc::sync_channel, Mutex, MutexGuard, OnceLock},
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
    sound: bool,
    autostart: bool,
    /// People sip, they don't empty a cup: one drink = a few sips.
    drink_sips: u32,
    /// ml per sip. Studies: a natural sip is 9–20 ml (self-chosen cup sip ~19.8 ml).
    sip_ml: u32,
    /// Goal during work hours: the guideline is 1500–1700 ml a day, about 1000 of it at work.
    goal_ml: u32,
    /// Only run during work hours (pauses at lunch, after work and on weekends).
    work_on: bool,
    workdays_only: bool,
    work_start: String,
    work_end: String,
    lunch_start: String,
    lunch_end: String,
    drank_ml: u32,
    drank_date: String,
}

impl Default for Settings {
    /// Office defaults: 09:00–18:00 with a 12:00–13:30 lunch is ~7.5 h at the desk. A reminder
    /// every 30 min (also a good "stand up" rhythm) × 3 sips (~60 ml) ≈ 15 × 60 ≈ 900–1000 ml.
    fn default() -> Self {
        Self {
            interval_min: 30,
            theme: "ocean".into(),
            mode: "ambient".into(),
            opacity: 0.7,
            text: "该喝水啦".into(),
            sound: true,
            autostart: false,
            drink_sips: 3,
            sip_ml: 20,
            goal_ml: 1000,
            work_on: true,
            // Off by default: China's 调休 makes some Saturdays/Sundays workdays.
            workdays_only: false,
            work_start: "09:00".into(),
            work_end: "18:00".into(),
            lunch_start: "12:00".into(),
            lunch_end: "13:30".into(),
            drank_ml: 0,
            drank_date: String::new(),
        }
    }
}

/// "HH:MM" → minutes since midnight.
fn minutes(s: &str) -> Option<u32> {
    let (h, m) = s.split_once(':')?;
    let (h, m) = (h.trim().parse::<u32>().ok()?, m.trim().parse::<u32>().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

impl Settings {
    /// Inside work hours, lunch cut out. Always true when the schedule is off.
    fn working_now(&self) -> bool {
        if !self.work_on {
            return true;
        }
        let (weekday, now) = win::local_clock();
        if self.workdays_only && (weekday == 0 || weekday == 6) {
            return false;
        }
        let at = |v: &str| minutes(v).unwrap_or(0);
        let lunch = at(&self.lunch_start) <= now && now < at(&self.lunch_end);
        at(&self.work_start) <= now && now < at(&self.work_end) && !lunch
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
    /// Outside work hours: no reminders, overlay hidden.
    resting: bool,
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
    /// The overlay is hidden (fullscreen app, off hours): WebView2 isn't told, so the page pauses itself.
    hidden: bool,
    resting: bool,
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
            resting: self.resting,
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
    /// Reset the daily ml counter on a new day. Returns true when it changed.
    fn roll_day(&mut self) -> bool {
        let today = win::today();
        if self.s.drank_date == today {
            return false;
        }
        self.s.drank_date = today;
        self.s.drank_ml = 0;
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
                c.s.drank_ml += c.s.drink_sips * c.s.sip_ml;
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
            // Double-click on the taskbar. Ignored right after a restart: the first click of a
            // double-click on a showing reminder already counted as a drink.
            "restart" if now - c.cycle_start > 2_000 && !c.resting => {
                c.restart(now);
                c.bump("restart");
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
            // Show a reminder now (also outside work hours, so it can be previewed any time).
            "test" => {
                let iv = c.interval_ms();
                c.restart(now - iv);
                c.reminding = true;
                c.bump("remind");
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
    // Off hours the bar goes away (a previewed reminder and its animation still show).
    let hidden = win::fullscreen_foreground(hwnd) || (c.resting && !expanded);
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
            let resting = !c.s.working_now();
            if resting != c.resting {
                // Lunch / evening: drop any reminder. Back at work: a fresh cycle, not an old one.
                c.resting = resting;
                if resting {
                    c.reminding = false;
                } else {
                    c.restart(now);
                }
                c.bump(if resting { "rest" } else { "work" });
                dirty = true;
            }
            if !c.resting && !c.reminding && c.paused_at.is_none() && now - c.cycle_start >= c.interval_ms() {
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

/// Double-click on empty taskbar space (where the bar is drawn) restarts the timer.
/// Clicks on apps, Start, tray icons or the clock are left alone (taskbar buttons via UI Automation).
fn double_click_restarts(app: AppHandle) {
    let (tx, rx) = sync_channel::<(i32, i32)>(4);
    win::watch_double_clicks(tx);
    let uia = win::Uia::new();
    for (x, y) in rx {
        let on_bar = {
            let c = core(&app);
            let shown = !c.hidden;
            shown && c.bar.is_some_and(|b| b.rc.left <= x && x < b.rc.right && b.rc.top <= y && y < b.rc.bottom)
        };
        if on_bar && uia.as_ref().is_some_and(|u| !u.on_taskbar_button(x, y)) {
            act(&app, "restart");
        }
    }
}

fn tooltip(c: &Core, now: i64) -> String {
    if c.reminding {
        return format!("喝水进度条 · {}！", c.s.text);
    }
    if c.resting {
        return format!("喝水进度条 · 休息时间 · 今日 {} ml", c.s.drank_ml);
    }
    if c.paused_at.is_some() {
        return "喝水进度条 · 已暂停".into();
    }
    let left = (c.interval_ms() - (now - c.cycle_start)).max(0);
    format!("喝水进度条 · 还有 {} 分钟 · 今日 {} / {} ml", (left + 59_999) / 60_000, c.s.drank_ml, c.s.goal_ml)
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
            &MenuItem::with_id(app, "drink", "我喝了几口，重新计时", true, None::<&str>)?,
            &MenuItem::with_id(app, "restart", "只重新计时", true, None::<&str>)?,
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
        let (drank_ml, drank_date) = (c.s.drank_ml, c.s.drank_date.clone());
        let d = Settings::default();
        // A bad "HH:MM" from the page falls back to the default time.
        let time = |v: String, fallback: String| if minutes(&v).is_some() { v } else { fallback };
        // Values come from a webview: clamp them, the counters stay backend-owned.
        c.s = Settings {
            interval_min: settings.interval_min.clamp(1, 600),
            opacity: settings.opacity.clamp(0.15, 1.0),
            text: settings.text.trim().chars().take(16).collect(),
            drink_sips: settings.drink_sips.clamp(1, 20),
            sip_ml: settings.sip_ml.clamp(5, 60),
            goal_ml: settings.goal_ml.clamp(100, 5000),
            work_start: time(settings.work_start, d.work_start),
            work_end: time(settings.work_end, d.work_end),
            lunch_start: time(settings.lunch_start, d.lunch_start),
            lunch_end: time(settings.lunch_end, d.lunch_end),
            drank_ml,
            drank_date,
            ..settings
        };
        if c.s.text.is_empty() {
            c.s.text = d.text;
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
        // A second launch opens the settings; `--preview` shows the reminder, `--restart` restarts the timer.
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if args.iter().any(|a| a == "--preview") {
                act(app, "test");
            } else if args.iter().any(|a| a == "--restart") {
                act(app, "restart");
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
            let resting = !s.working_now();
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
                resting,
            };
            c.roll_day();
            app.manage(Mutex::new(c));
            let _ = APP.set(handle.clone());

            sync_overlay(&handle);
            build_tray(&handle)?;
            win::on_foreground_change(on_foreground);
            let h = handle.clone();
            thread::spawn(move || ticker(h));
            let h = handle.clone();
            thread::spawn(move || double_click_restarts(h));

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
