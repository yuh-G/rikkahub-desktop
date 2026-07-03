//! Rikkahub PC — Tauri shell.
//!
//! The Bun-compiled `rikkahub-server.exe` is spawned as a sidecar so the existing HTTP +
//! SSE backend keeps working unchanged. The webview points at the sidecar's loopback
//! address. The shell adds:
//!   - Window lifecycle (custom titlebar commands, drag region)
//!   - Custom data directory (persisted in user-config.json, exported to sidecar via env)
//!   - Sidecar startup wait + graceful shutdown on app exit

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

/// Default loopback port the sidecar listens on. Matches `pc-server/server.ts`.
const SIDECAR_PORT: u16 = 8080;

/// How long we wait for the sidecar HTTP server to start accepting connections
/// before giving up and showing an error to the user.
const SIDECAR_READY_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Default)]
struct SidecarState {
    child: Mutex<Option<CommandChild>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct UserConfig {
    /// Absolute path to where pc-data should live. None = default (next to exe).
    data_dir: Option<String>,
    /// Whether closing the main window hides to the tray (true) or quits (false).
    /// None = default-on, matching the convention of most modern desktop clients.
    #[serde(default)]
    minimize_to_tray: Option<bool>,
}

/// User config lives in the user's roaming AppData so it survives uninstall+reinstall.
fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to resolve app config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {e}"))?;
    Ok(dir.join("user-config.json"))
}

fn load_user_config(app: &AppHandle) -> UserConfig {
    let Ok(path) = config_path(app) else {
        return UserConfig::default();
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return UserConfig::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_user_config(app: &AppHandle, cfg: &UserConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let text = serde_json::to_string_pretty(cfg)
        .map_err(|e| format!("Failed to serialize config: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("Failed to write config: {e}"))?;
    Ok(())
}

/// Resolve the effective data directory in this priority order:
///   1. env var `RIKKAHUB_PC_DATA_DIR` (developer/test override)
///   2. value persisted in user-config.json (set by user via Settings UI or installer)
///   3. `pc-data/` next to the running exe (portable default)
fn resolve_data_dir(app: &AppHandle) -> PathBuf {
    if let Ok(env) = std::env::var("RIKKAHUB_PC_DATA_DIR") {
        if !env.trim().is_empty() {
            return PathBuf::from(env);
        }
    }
    let cfg = load_user_config(app);
    if let Some(dir) = cfg.data_dir {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    exe_dir().join("pc-data")
}

fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Block until the sidecar prints its `RIKKAHUB_PORT:<n>` marker (meaning Bun.serve bound
/// successfully), or until the child dies / we time out. Polling the channel with a short
/// timeout lets us notice a dead child promptly instead of waiting the full duration — this
/// also covers the silent-orphan case where another app already owns the port range and our
/// spawn exits on EADDRINUSE before ever printing a port marker.
fn wait_for_sidecar_port(
    port_rx: std::sync::mpsc::Receiver<u16>,
    child_dead: &AtomicBool,
    timeout: Duration,
) -> Result<u16, String> {
    let started = Instant::now();
    loop {
        if child_dead.load(Ordering::Acquire) {
            return Err(format!(
                "Rikkahub 启动失败：后端进程已退出。\n\n\
                端口 {SIDECAR_PORT} 附近可能被其他程序占用。请关闭占用该端口的程序，\
                或在 设置 → 代理与端口 中更换端口后重新启动 Rikkahub。"
            ));
        }
        match port_rx.recv_timeout(Duration::from_millis(200)) {
            Ok(port) => return Ok(port),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if started.elapsed() >= timeout {
                    return Err(format!(
                        "Rikkahub 后端服务在 {timeout:?} 内未启动完成，请重试。"
                    ));
                }
                // otherwise keep looping and re-check child_dead
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                // stdout pump task ended without ever emitting a port marker — the sidecar
                // process has exited. Treat it the same as child_dead.
                return Err(format!(
                    "Rikkahub 启动失败：后端进程意外退出。\n\n\
                    端口 {SIDECAR_PORT} 附近可能被其他程序占用。请关闭占用该端口的程序，\
                    或在 设置 → 代理与端口 中更换端口后重新启动 Rikkahub。"
                ));
            }
        }
    }
}

fn spawn_sidecar(
    app: &AppHandle,
) -> Result<(CommandChild, Arc<AtomicBool>, std::sync::mpsc::Receiver<u16>), String> {
    let data_dir = resolve_data_dir(app);
    fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create data dir {}: {e}", data_dir.display()))?;

    let shell = app.shell();
    let cmd = shell
        .sidecar("rikkahub-server")
        .map_err(|e| format!("Sidecar binary `rikkahub-server` not found: {e}"))?
        // `--no-open` skips the sidecar's "auto-launch system browser" behavior, which is
        // meant for portable / standalone use. Inside the Tauri shell the webview already
        // navigates to the same URL, so a second browser window would just be noise.
        .args(["--no-open"])
        .env("RIKKAHUB_PC_DATA_DIR", &data_dir);
        // NOTE: we deliberately do NOT pass PORT here. The sidecar now picks its own port
        // (8080 by default, walking up on conflict) and reports the actual value via the
        // `RIKKAHUB_PORT:<n>` stdout marker parsed below. Hardcoding 8080 would make the
        // auto-port feature impossible, since the env override has higher priority than the
        // user's preferred-port setting.

    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {e}"))?;

    // Tie the sidecar's lifetime to the shell process via a Windows Job Object so that even
    // if the user kills `rikkahub.exe` from Task Manager (or it crashes), the kernel reaps
    // `rikkahub-server.exe` along with it. Without this the sidecar would linger as an orphan
    // holding its port and the next launch would fail to bind.
    #[cfg(windows)]
    bind_to_kill_on_close_job(child.pid());

    // Tracks whether the sidecar process terminated. Used by the readiness loop to detect
    // the "port already owned, our spawn died on EADDRINUSE" failure mode.
    let dead = Arc::new(AtomicBool::new(false));
    let dead_clone = dead.clone();

    // The sidecar prints a single `RIKKAHUB_PORT:<n>` line on stdout once Bun.serve binds.
    // We parse it here and forward the value over a channel so the setup routine can navigate
    // the webview to the correct port — the static window URL is still 8080, so when the
    // sidecar hopped to another port we re-navigate after this resolves.
    let (port_tx, port_rx) = std::sync::mpsc::channel::<u16>();
    let port_tx_clone = port_tx.clone();

    // Pipe sidecar stdout/stderr to the host stdout so `cargo tauri dev` users see logs.
    // In release this is silent because of the `windows_subsystem = "windows"` attribute.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    if let Ok(text) = String::from_utf8(line) {
                        let trimmed = text.trim_end();
                        eprintln!("[sidecar] {}", trimmed);
                        // `RIKKAHUB_PORT:8082` → Some(8082). Only the first hit matters; the
                        // channel is consumed once by the setup wait.
                        if let Some(rest) = trimmed.strip_prefix("RIKKAHUB_PORT:") {
                            if let Ok(p) = rest.trim().parse::<u16>() {
                                let _ = port_tx_clone.send(p);
                            }
                        }
                    }
                }
                CommandEvent::Stderr(line) => {
                    if let Ok(text) = String::from_utf8(line) {
                        eprintln!("[sidecar:err] {}", text.trim_end());
                    }
                }
                CommandEvent::Error(err) => {
                    eprintln!("[sidecar:error] {err}");
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[sidecar] terminated: {payload:?}");
                    dead_clone.store(true, Ordering::Release);
                    break;
                }
                _ => {}
            }
        }
        // Stream closed without an explicit Terminated event — treat as dead too.
        dead_clone.store(true, Ordering::Release);
    });

    Ok((child, dead, port_rx))
}

/// On Windows, putting the sidecar into a Job Object with `KILL_ON_JOB_CLOSE` ensures the OS
/// will terminate the child when the parent's last handle to the job closes — i.e., when
/// `rikkahub.exe` exits for any reason, including SIGKILL-equivalents. The job is held by an
/// open HANDLE we deliberately *don't* close so it stays alive for the parent's whole life.
#[cfg(windows)]
fn bind_to_kill_on_close_job(child_pid: u32) {
    use std::mem::size_of;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_BASIC_LIMIT_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_ALL_ACCESS};

    static JOB_HANDLE: std::sync::OnceLock<usize> = std::sync::OnceLock::new();

    unsafe {
        // Lazily create the singleton job — first sidecar spawn establishes it; later spawns
        // (e.g. after a data-dir change + restart) attach to the same job.
        let job_raw = *JOB_HANDLE.get_or_init(|| {
            let job = CreateJobObjectW(None, windows::core::PCWSTR::null()).unwrap_or_default();
            if job.is_invalid() {
                return 0;
            }
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
                BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION {
                    LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                    ..Default::default()
                },
                ..Default::default()
            };
            let _ = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            let _ = &mut info; // keep alive past the call
            job.0 as usize
        });
        if job_raw == 0 {
            return;
        }
        let job = HANDLE(job_raw as *mut _);
        let proc = match OpenProcess(PROCESS_ALL_ACCESS, false, child_pid) {
            Ok(h) => h,
            Err(err) => {
                eprintln!("[sidecar:job] OpenProcess failed: {err:?}");
                return;
            }
        };
        if AssignProcessToJobObject(job, proc).is_err() {
            eprintln!("[sidecar:job] AssignProcessToJobObject failed (already in a job?)");
        }
        // We intentionally close only the per-call process handle, not the job handle —
        // the job must outlive this function so the OS keeps the kill-on-close semantics.
        let _ = CloseHandle(proc);
    }
}

#[tauri::command]
fn get_data_dir(app: AppHandle) -> Result<String, String> {
    Ok(resolve_data_dir(&app).to_string_lossy().into_owned())
}

#[tauri::command]
fn set_data_dir(app: AppHandle, path: String) -> Result<(), String> {
    let trimmed = path.trim().to_string();
    let mut cfg = load_user_config(&app);
    cfg.data_dir = if trimmed.is_empty() { None } else { Some(trimmed) };
    save_user_config(&app, &cfg)
}

// --- System tray: hide-on-close + click-to-restore -------------------------
//
// The tray lets the window hide instead of quitting on close, so background
// work (SSE streams, long tool calls, in-flight requests) keeps running while
// the UI is dismissed. A menu entry gives an explicit "Quit" path so closing
// to tray never becomes a trap where the user can never exit.

struct TrayStrings {
    show: &'static str,
    quit: &'static str,
    tooltip: &'static str,
}

/// Build the tray label set from the system locale. We only need to distinguish
/// Chinese vs. everything-else (the app's two UI locales); rebuilding the tray
/// on the fly when the user switches languages isn't worth it for two items.
fn tray_strings() -> TrayStrings {
    let is_zh = sys_locale::get_locale()
        .map(|l| l.starts_with("zh"))
        .unwrap_or(false);
    if is_zh {
        TrayStrings {
            show: "显示主窗口",
            quit: "退出 Rikkahub",
            tooltip: "Rikkahub",
        }
    } else {
        TrayStrings {
            show: "Show window",
            quit: "Quit Rikkahub",
            tooltip: "Rikkahub",
        }
    }
}

/// Reads the hide-on-close preference. `None` (unset) means default-on, so the
/// feature is active on first launch without the user having to opt in —
/// matching Discord / Telegram / WeChat convention.
fn minimize_to_tray_enabled(app: &AppHandle) -> bool {
    load_user_config(app).minimize_to_tray.unwrap_or(true)
}

/// Restore the main window from taskbar / tray: unminimize + show + focus.
/// Each call is a no-op when the window is already in that state.
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Builds the system tray icon + menu. Failure is non-fatal: we log and move on
/// so the app still launches if the tray can't be created for some reason.
fn build_tray(app: &AppHandle) -> Result<(), String> {
    let strings = tray_strings();
    let show_item = MenuItem::with_id(app, "tray_show", strings.show, true, None::<&str>)
        .map_err(|e| format!("tray show item: {e}"))?;
    let quit_item = MenuItem::with_id(app, "tray_quit", strings.quit, true, None::<&str>)
        .map_err(|e| format!("tray quit item: {e}"))?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])
        .map_err(|e| format!("tray menu: {e}"))?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "default window icon missing".to_string())?;
    let _ = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip(strings.tooltip)
        .menu(&menu)
        // Left-click is reserved for restoring the window (see on_tray_icon_event).
        // Without this, the default behavior would pop the menu on left-click and
        // our restore handler would never fire.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray_show" => show_main_window(app),
            "tray_quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|e| format!("tray build: {e}"))?;
    Ok(())
}

#[tauri::command]
fn get_minimize_to_tray(app: AppHandle) -> bool {
    minimize_to_tray_enabled(&app)
}

#[tauri::command]
fn set_minimize_to_tray(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut cfg = load_user_config(&app);
    cfg.minimize_to_tray = Some(enabled);
    save_user_config(&app, &cfg)
}

/// Launches an installer .exe as a detached process so our shell exiting doesn't take it
/// down. Used by the in-app update flow: backend downloads the new installer to %TEMP%,
/// frontend calls this to launch it, then the user is prompted to close Rikkahub so the
/// NSIS installer's "close target app" check doesn't block.
///
/// We don't attach the child to the kill-on-close job object (that's only for the sidecar)
/// and we drop the `Child` handle without `wait()` so the installer process is fully
/// independent. After this returns Ok, the caller should immediately exit the app.
#[tauri::command]
fn launch_installer(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Installer path is empty".to_string());
    }
    let installer_path = PathBuf::from(trimmed);
    if !installer_path.exists() {
        return Err(format!("Installer not found: {}", installer_path.display()));
    }
    // Sanity: only allow .exe so we don't accidentally run scripts the backend handed us.
    let ext_ok = installer_path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("exe"))
        .unwrap_or(false);
    if !ext_ok {
        return Err(format!("Refusing to launch non-exe: {}", installer_path.display()));
    }
    spawn_installer(&installer_path)
        .map(|_| ())
        .map_err(|e| format!("Failed to launch installer: {e}"))
}

/// 启动安装器为独立进程,脱离壳可能所在的 Job Object。
///
/// 壳(rikkahub.exe)自己不入它给 sidecar 建的 KILL_ON_JOB_CLOSE job,正常双击启动时安装器
/// 不会被连坐;但若壳被外部放进 job(从 IDE / 沙箱 / 进程监视器拉起),Windows 会自动把安装器
/// 加入同一 job,壳退出时 KILL_ON_JOB_CLOSE 会连坐杀掉安装器。CREATE_BREAKAWAY_FROM_JOB 让
/// 子进程脱离 job;若所处 job 不允许 breakaway,回退普通 spawn 保证安装器至少能启动。
///
/// 注意:这里只用 CreateProcess 不用 ShellExecute("runas")——当前 installMode=currentUser,
/// 安装器 manifest 是 asInvoker,CreateProcess 直接启动不弹 UAC;改 runas 会强制提升、每次
/// 更新都弹 UAC,是 UX 退化。将来 installMode 改 perMachine/both 再换 ShellExecuteW。
#[cfg(windows)]
fn spawn_installer(installer: &Path) -> std::io::Result<std::process::Child> {
    use std::os::windows::process::CommandExt;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    std::process::Command::new(installer)
        .creation_flags(CREATE_BREAKAWAY_FROM_JOB)
        .spawn()
        .or_else(|_| std::process::Command::new(installer).creation_flags(0).spawn())
}

#[cfg(not(windows))]
fn spawn_installer(installer: &Path) -> std::io::Result<std::process::Child> {
    std::process::Command::new(installer).spawn()
}

/// Modal error dialog shown during startup when the sidecar can't come up. We use
/// `blocking_show` so the user actually sees it before `app.exit()` tears the process down.
fn show_startup_error(app: &AppHandle, message: &str) {
    eprintln!("[startup-error] {message}");
    app.dialog()
        .message(message)
        .kind(MessageDialogKind::Error)
        .title("Rikkahub 启动失败")
        .blocking_show();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single-instance plugin: clicking the desktop shortcut while Rikkahub is already
        // running just focuses the existing window instead of spawning a second shell whose
        // sidecar would EADDRINUSE-die and leave the user with a broken titlebar (see the
        // port-conflict scenario fixed in v1.0.1).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            get_data_dir,
            set_data_dir,
            launch_installer,
            get_minimize_to_tray,
            set_minimize_to_tray,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Start the sidecar, then wait for it to print its `RIKKAHUB_PORT:<n>` marker. The
            // sidecar now picks its own port (8080 by default, walking up on conflict) and we
            // can't know which one until that line arrives. If the sidecar dies early — most
            // commonly EADDRINUSE because the whole candidate range is busy — show an error
            // dialog and quit; otherwise the webview would sit on a dead/orphan URL.
            let (port_rx, child_dead) = match spawn_sidecar(&handle) {
                Ok((child, dead, port_rx)) => {
                    if let Some(state) = handle.try_state::<SidecarState>() {
                        *state.child.lock().unwrap() = Some(child);
                    }
                    (port_rx, dead)
                }
                Err(err) => {
                    show_startup_error(&handle, &format!("Rikkahub 后端启动失败：\n\n{err}"));
                    handle.exit(1);
                    return Ok(());
                }
            };

            let actual_port =
                match wait_for_sidecar_port(port_rx, &child_dead, SIDECAR_READY_TIMEOUT) {
                    Ok(port) => port,
                    Err(msg) => {
                        show_startup_error(&handle, &msg);
                        handle.exit(1);
                        return Ok(());
                    }
                };

            handle.emit("sidecar://ready", true).ok();

            // The window's static URL (tauri.conf.json) is http://localhost:8080. When the
            // sidecar had to use a different port, re-navigate the webview there. The eval'd
            // script guards with an "already on this port" check so repeated attempts don't
            // interrupt a navigation that has already succeeded; the short retry loop covers
            // the case where the initial load landed on a connection-refused error page and
            // the very first eval didn't take effect immediately.
            if actual_port != SIDECAR_PORT {
                if let Some(window) = handle.get_webview_window("main") {
                    let js = format!(
                        "(function(){{var t='http://localhost:{p}';try{{if(location.href.indexOf(':{p}')===-1)location.replace(t)}}catch(e){{}}}})()",
                        p = actual_port
                    );
                    for _ in 0..6 {
                        let _ = window.eval(&js);
                        thread::sleep(Duration::from_millis(250));
                    }
                }
            }

            if let Err(err) = build_tray(&handle) {
                eprintln!("[tray] failed to build tray icon: {err}");
            }

            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                let app = window.app_handle();
                if minimize_to_tray_enabled(app) {
                    // Hide to tray instead of closing. The sidecar keeps running so
                    // SSE streams / tool calls survive. Real teardown happens via the
                    // tray "Quit" entry → app.exit(0) → ExitRequested below.
                    api.prevent_close();
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.hide();
                    }
                } else {
                    // User opted out of tray: tear down the sidecar so the Bun process
                    // doesn't linger in the background.
                    if let Some(state) = app.try_state::<SidecarState>() {
                        if let Some(child) = state.child.lock().unwrap().take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app_handle.try_state::<SidecarState>() {
                    if let Some(child) = state.child.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
