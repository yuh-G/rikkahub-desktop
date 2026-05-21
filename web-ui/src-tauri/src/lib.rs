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
    net::TcpStream,
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, RunEvent, WindowEvent,
};
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

/// Probe localhost:8080 until the sidecar accepts a connection or we time out.
fn wait_for_sidecar_ready(timeout: Duration) -> bool {
    let started = Instant::now();
    let addr = format!("127.0.0.1:{SIDECAR_PORT}");
    while started.elapsed() < timeout {
        if TcpStream::connect_timeout(
            &addr.parse().expect("valid loopback addr"),
            Duration::from_millis(200),
        )
        .is_ok()
        {
            return true;
        }
        thread::sleep(Duration::from_millis(150));
    }
    false
}

fn spawn_sidecar(app: &AppHandle) -> Result<CommandChild, String> {
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
        .env("RIKKAHUB_PC_DATA_DIR", &data_dir)
        .env("PORT", SIDECAR_PORT.to_string());

    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {e}"))?;

    // Tie the sidecar's lifetime to the shell process via a Windows Job Object so that even
    // if the user kills `rikkahub.exe` from Task Manager (or it crashes), the kernel reaps
    // `rikkahub-server.exe` along with it. Without this the sidecar would linger as an orphan
    // listening on :8080 and the next launch would fail to bind.
    #[cfg(windows)]
    bind_to_kill_on_close_job(child.pid());

    // Pipe sidecar stdout/stderr to the host stdout so `cargo tauri dev` users see logs.
    // In release this is silent because of the `windows_subsystem = "windows"` attribute.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    if let Ok(text) = String::from_utf8(line) {
                        eprintln!("[sidecar] {}", text.trim_end());
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
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(child)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![get_data_dir, set_data_dir])
        .setup(|app| {
            let handle = app.handle().clone();

            // Start the sidecar before the webview loads, then wait for the port to come up
            // so the initial page navigation hits a live server.
            match spawn_sidecar(&handle) {
                Ok(child) => {
                    if let Some(state) = handle.try_state::<SidecarState>() {
                        *state.child.lock().unwrap() = Some(child);
                    }
                }
                Err(err) => {
                    eprintln!("Sidecar startup failed: {err}");
                    // Continue — the webview will show its own error toast when /api fails.
                }
            }

            let ready = wait_for_sidecar_ready(SIDECAR_READY_TIMEOUT);
            handle
                .emit("sidecar://ready", ready)
                .ok();

            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { .. } => {
                // Tear down the sidecar when the main window is closed so the Bun process
                // doesn't linger in the background.
                if let Some(state) = window.app_handle().try_state::<SidecarState>() {
                    if let Some(child) = state.child.lock().unwrap().take() {
                        let _ = child.kill();
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
