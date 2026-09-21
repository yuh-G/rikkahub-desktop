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
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU16, Ordering},
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

#[derive(Default)]
struct SidecarState {
    child: Mutex<Option<CommandChild>>,
    /// Actual sidecar HTTP port once known (0 = not started yet). Needed by the
    /// graceful-shutdown path so we can POST /api/app/shutdown before killing.
    port: AtomicU16,
}

/// 全面审查 8-2:壳退出前先请求 sidecar 优雅停机。服务端把 state.json、活库脏行、
/// 生成中会话、WAL checkpoint 全部刷盘后才返回 200——收到 200 后再 kill 是零丢失的。
/// 连接/写/读任一步失败或超时(约 3s 上限)则返回 false,调用方直接硬杀兜底(旧行为)。
/// Windows 上 child.kill() = TerminateProcess,sidecar 的 SIGTERM 钩子不会运行,
/// 这个 HTTP 通道是 Tauri 形态唯一的优雅停机路径。
fn request_sidecar_shutdown(port: u16) -> bool {
    use std::io::{Read, Write};
    let addr = match format!("127.0.0.1:{port}").parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(500))
    else {
        return false;
    };
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    // 服务端刷盘(state 尾随写追平 + 活库 reconcile + checkpoint)通常毫秒级,给足 2.5s。
    let _ = stream.set_read_timeout(Some(Duration::from_millis(2500)));
    // HTTP/1.1 头部行结束符必须是 CRLF:Rust 多行字符串字面量的换行会被规范化成 bare LF,
    // Bun 的解析器直接拒收(505 HTTP Version Not Supported)——曾导致优雅停机从未成功、
    // 每次退出都走硬杀,pending 取证残留,下次启动误报"上次未正常退出"(日志问题 2 真根因)。
    let request = format!(
        "POST /api/app/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 256];
    match stream.read(&mut buf) {
        Ok(n) if n > 0 => String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200"),
        _ => false,
    }
}

/// Take the child out of the state and shut it down: graceful HTTP first, hard kill after.
fn shutdown_sidecar(state: &SidecarState) {
    let Some(child) = state.child.lock().unwrap().take() else {
        return;
    };
    let port = state.port.load(Ordering::Relaxed);
    if port != 0 && request_sidecar_shutdown(port) {
        // 200 已确认数据落盘,服务端随即自退;稍等让它体面退出,kill 只是兜底清理。
        thread::sleep(Duration::from_millis(300));
    }
    let _ = child.kill();
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct UserConfig {
    /// Absolute path to where pc-data should live. None = default (next to exe).
    data_dir: Option<String>,
    /// Whether closing the main window hides to the tray (true) or quits (false).
    /// None = default-on, matching the convention of most modern desktop clients.
    #[serde(default)]
    minimize_to_tray: Option<bool>,
    /// 专题8:未知字段透传。新版本(或降级前的新字段)写入的键在旧二进制的
    /// load→save 往返中原样保留,而不是被静默丢弃——"设置遗忘"类问题的预防线。
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
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
    match serde_json::from_str(&text) {
        Ok(cfg) => cfg,
        Err(_) => {
            // 专题8:解析失败不再静默回默认值继续跑——那样下一次 save 会把损坏前的
            // data_dir/托盘设置永久覆盖(用户会以为数据全丢了)。把坏文件挪到一边
            // 留证可恢复,本次按默认运行。
            let _ = fs::rename(&path, path.with_extension("json.corrupted"));
            UserConfig::default()
        }
    }
}

/// B2(专题8复查):config 的 load-modify-save 无锁并发会互吃字段(后写者整文件覆盖先
/// 写者的修改),且所有写路径共用同一 tmp 文件,并发写 tmp 会互相截断。所有
/// "读-改-写"路径(set_data_dir/set_minimize_to_tray/安装器交接合并)持锁完成。
/// 毒化锁降级为继续持有(配置写入不因某次 panic 永久拒写)。
static CONFIG_WRITE_LOCK: Mutex<()> = Mutex::new(());

fn lock_config_write() -> std::sync::MutexGuard<'static, ()> {
    CONFIG_WRITE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn save_user_config(app: &AppHandle, cfg: &UserConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let text = serde_json::to_string_pretty(cfg)
        .map_err(|e| format!("Failed to serialize config: {e}"))?;
    // 专题8:temp+rename 原子写。此前 fs::write 直接覆盖,崩溃/断电时写一半,
    // 下次启动解析失败 → data_dir 丢失,应用指回默认数据目录。
    // B2(专题8复查):rename 前 sync_all 强制数据落盘——否则断电时 rename 元数据可能
    // 先于文件内容持久化,目标变空/截断文件,原子写形同虚设。
    let tmp = path.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&tmp).map_err(|e| format!("Failed to write config: {e}"))?;
        file.write_all(text.as_bytes())
            .map_err(|e| format!("Failed to write config: {e}"))?;
        file.sync_all().map_err(|e| format!("Failed to flush config: {e}"))?;
    }
    fs::rename(&tmp, &path).map_err(|e| format!("Failed to commit config: {e}"))?;
    Ok(())
}

/// Consume the installer's data-dir handoff file (NSIS_HOOK_POSTINSTALL writes the
/// chosen path as a plain-text single line). The installer must never write
/// user-config.json itself: rewriting a JSON it doesn't fully parse clobbers every
/// field it doesn't know about — that's exactly how `minimize_to_tray: false` kept
/// resurrecting to default-on after every update (专题6). We merge here via
/// load-modify-save (all other fields survive), then delete the handoff.
/// Must run before the first resolve_data_dir call so a fresh install's choice takes
/// effect on the very first launch.
/// B3(专题6复查):交接文件双格式解码。新版安装器用 FileWriteUTF16LE /BOM 写
/// (Unicode NSIS 的 FileWrite 按系统 ANSI 码页写,中文路径不是合法 UTF-8);
/// 无 BOM 则按 UTF-8 尝试(兼容旧版安装器的纯 ASCII 路径)。
fn decode_handoff_text(bytes: &[u8]) -> Option<String> {
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        return String::from_utf16(&units).ok();
    }
    String::from_utf8(bytes.to_vec()).ok()
}

fn consume_installer_data_dir_handoff(app: &AppHandle) {
    let Ok(config_dir) = app.path().app_config_dir() else {
        return;
    };
    let handoff = config_dir.join("installer-data-dir.txt");
    let Ok(bytes) = fs::read(&handoff) else {
        return;
    };
    let Some(text) = decode_handoff_text(&bytes) else {
        // B3:解不出来(旧版安装器 ANSI 写的非 ASCII 路径)必须删文件——重试永远
        // 同样失败,不删则每次启动都重试一遍且文件永久残留。记日志便于排查。
        eprintln!("[rikkahub] installer handoff file is neither UTF-16LE(BOM) nor UTF-8; discarding");
        let _ = fs::remove_file(&handoff);
        return;
    };
    let path = text.trim();
    if !path.is_empty() {
        let _guard = lock_config_write();
        let mut cfg = load_user_config(app);
        if cfg.data_dir.as_deref() != Some(path) {
            cfg.data_dir = Some(path.to_string());
            if save_user_config(app, &cfg).is_err() {
                // 合并失败(磁盘/权限):保留交接文件,下次启动重试。本次启动
                // resolve_data_dir 读到旧配置——与安装前行为一致,不丢数据。
                return;
            }
        }
    }
    let _ = fs::remove_file(&handoff);
}

/// Resolve the effective data directory in this priority order:
///   1. env var `RIKKAHUB_PC_DATA_DIR` (developer/test override)
///   2. value persisted in user-config.json (written only by this shell — either the
///      Settings UI's set_data_dir command, or the startup merge of the installer's
///      plain-text handoff file; the installer never writes the JSON itself)
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
/// successfully) or the child dies. R1-1：服务端已改为"先绑端口打标记、迁移后置"，标记
/// 正常应在数秒内到达；子进程仍存活就继续等——旧的 20s 硬超时会把正在迁移大数据的
/// 后端连坐杀死（迁移下次从头再来），形成"每次启动都超时被杀"的死循环。真正的失败
/// （端口耗尽/数据目录被锁/迁移崩溃）都会让子进程退出，由 child_dead 分支兜住并展示
/// RIKKAHUB_FATAL 标记带出的真实原因（R1-4）。
fn wait_for_sidecar_port(
    port_rx: std::sync::mpsc::Receiver<u16>,
    child_dead: &AtomicBool,
    fatal_message: &Mutex<Option<String>>,
) -> Result<u16, String> {
    let started = Instant::now();
    let mut last_log = Instant::now();
    loop {
        if child_dead.load(Ordering::Acquire) {
            return Err(startup_failure_message(fatal_message));
        }
        match port_rx.recv_timeout(Duration::from_millis(200)) {
            Ok(port) => return Ok(port),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if last_log.elapsed() >= Duration::from_secs(10) {
                    last_log = Instant::now();
                    eprintln!(
                        "[startup] still waiting for sidecar port marker ({}s, child alive)...",
                        started.elapsed().as_secs()
                    );
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                // stdout pump task ended without ever emitting a port marker — the sidecar
                // process has exited. Treat it the same as child_dead.
                return Err(startup_failure_message(fatal_message));
            }
        }
    }
}

/// R1-4：启动失败文案分诊。优先展示 sidecar 退出前打出的 `RIKKAHUB_FATAL:<code>:<message>`
/// 标记（端口耗尽/数据目录被另一实例锁定/迁移失败各有真实原因，服务端给的已是用户可读
/// 中文）；没有标记才回通用文案——绝不再无条件断言"端口被占用"（那会误导用户反复改
/// 端口陷入无解循环，而真实原因可能是实例锁）。
fn startup_failure_message(fatal_message: &Mutex<Option<String>>) -> String {
    if let Some(message) = fatal_message.lock().unwrap().clone() {
        return format!("Rikkahub 启动失败：\n\n{message}");
    }
    "Rikkahub 启动失败：后端进程意外退出。\n\n\
     请重启尝试，诊断信息见应用安装目录下 pc-data/logs/server.log。"
        .to_string()
}

type FatalMessage = Arc<Mutex<Option<String>>>;

fn spawn_sidecar(
    app: &AppHandle,
) -> Result<(CommandChild, Arc<AtomicBool>, FatalMessage, std::sync::mpsc::Receiver<u16>), String> {
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

    // R1-4：sidecar 退出前打出的单行诊断标记（RIKKAHUB_FATAL:<code>:<message>），由
    // stdout 泵捕获；child_dead 后 startup_failure_message 用它替换通用文案。
    let fatal: FatalMessage = Arc::new(Mutex::new(None));
    let fatal_clone = fatal.clone();

    // The sidecar prints a single `RIKKAHUB_PORT:<n>` line on stdout once Bun.serve binds.
    // We parse it here and forward the value over a channel so the setup routine can navigate
    // the webview to the correct port — the window opens on the bundled splash page (a local
    // asset, so the user never sees a connection-refused page), and is re-navigated to the
    // real origin once this resolves.
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
                        // R1-4：`RIKKAHUB_FATAL:<code>:<message>`。code 对齐退出码，目前
                        // 仅进日志；文案由服务端给出（已是用户可读中文）。
                        if let Some(rest) = trimmed.strip_prefix("RIKKAHUB_FATAL:") {
                            let message = rest
                                .split_once(':')
                                .map(|(_, m)| m.trim().to_string())
                                .unwrap_or_else(|| rest.to_string());
                            if !message.is_empty() {
                                *fatal_clone.lock().unwrap() = Some(message);
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

    Ok((child, dead, fatal, port_rx))
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
    let _guard = lock_config_write();
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

/// issue12: Renders a crisp tray icon for the current display scale. Windows sizes tray
/// icons at 16px x DPI scale (24px at 150%, 20px at 125%); feeding the 32px default window
/// icon makes the OS stretch it with a low-quality filter - visibly blurry next to other
/// apps. We decode the 256px master PNG and Lanczos-downscale it to the exact target size.
fn tray_icon_for_scale(scale: f64) -> Option<tauri::image::Image<'static>> {
    static MASTER_PNG: &[u8] = include_bytes!("../icons/128x128@2x.png");
    let target = ((16.0 * scale).round() as u32).clamp(16, 64);
    let master = image::load_from_memory_with_format(MASTER_PNG, image::ImageFormat::Png).ok()?;
    let resized = master
        .resize_exact(target, target, image::imageops::FilterType::Lanczos3)
        .into_rgba8();
    Some(tauri::image::Image::new_owned(resized.into_raw(), target, target))
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
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    let icon = tray_icon_for_scale(scale)
        .or_else(|| app.default_window_icon().cloned())
        .ok_or_else(|| "tray icon unavailable".to_string())?;
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
    let _guard = lock_config_write();
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
        // 域4-1(专题-交互审查 2A):审批等待桌面通知——AI 等审批而窗口失焦时提醒。
        .plugin(tauri_plugin_notification::init())
        // 专题8:记忆窗口尺寸/位置/最大化状态,退出时保存、启动时恢复。
        // D12(复查):排除 VISIBLE——可见性由应用自己管(就绪后 show、托盘 hide),
        // 插件若恢复"上次退出时隐藏在托盘"的不可见态,下次启动窗口不出现;若过早
        // 恢复可见又会在前端就绪前闪白屏。
        // H1:排除 DECORATIONS——窗饰是应用设计决策(G 轮回归原生标题栏),不是用户
        // 窗口状态;不排除的话,插件会把无边框时代存下的 decorations:false 恢复回去,
        // 导致升级后"缩小/放大/关闭"行整个消失。
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::VISIBLE
                        & !tauri_plugin_window_state::StateFlags::DECORATIONS,
                )
                .build(),
        )
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

            // 专题8续(尺寸记忆跳动):主窗口在 tauri.conf.json 里以 visible:false 创建,
            // window-state 插件在窗口创建钩子里(先于 setup)已把记忆的尺寸/位置/最大化
            // 恢复到隐藏窗口上,此刻再显示——首帧即上次几何,消除"默认大小闪现→跳到
            // 记忆大小"的割裂。放在 setup 最前,保持"启动即见窗"的原有体验。
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.show();
            }

            // 安装器数据目录交接必须先于 spawn_sidecar(内部 resolve_data_dir 决定
            // 传给后端的 RIKKAHUB_PC_DATA_DIR),否则全新安装的首次启动用错目录。
            consume_installer_data_dir_handoff(&handle);

            // Start the sidecar, then wait for it to print its `RIKKAHUB_PORT:<n>` marker. The
            // sidecar now picks its own port (8080 by default, walking up on conflict) and we
            // can't know which one until that line arrives. If the sidecar dies early — most
            // commonly EADDRINUSE because the whole candidate range is busy — show an error
            // dialog and quit; otherwise the webview would sit on a dead/orphan URL.
            let (port_rx, child_dead, fatal_message) = match spawn_sidecar(&handle) {
                Ok((child, dead, fatal, port_rx)) => {
                    if let Some(state) = handle.try_state::<SidecarState>() {
                        *state.child.lock().unwrap() = Some(child);
                    }
                    (port_rx, dead, fatal)
                }
                Err(err) => {
                    show_startup_error(&handle, &format!("Rikkahub 后端启动失败：\n\n{err}"));
                    handle.exit(1);
                    return Ok(());
                }
            };

            // R1-1：就绪等待移出 setup 主线程。服务端"先绑端口"后标记正常数秒内到达，
            // 但极端情况（安全软件拦截、磁盘极慢）下可能更久——在主线程上等会冻结窗口。
            let wait_handle = handle.clone();
            thread::spawn(move || {
                let actual_port = match wait_for_sidecar_port(port_rx, &child_dead, &fatal_message)
                {
                    Ok(port) => port,
                    Err(msg) => {
                        show_startup_error(&wait_handle, &msg);
                        wait_handle.exit(1);
                        return;
                    }
                };

                if let Some(state) = wait_handle.try_state::<SidecarState>() {
                    state.port.store(actual_port, Ordering::Relaxed);
                }

                wait_handle.emit("sidecar://ready", true).ok();

                // 端口标记到达 = Bun.serve 已在监听。窗口初始 URL（tauri.conf.json）指向
                // 内嵌的 splash.html（本地资源，零网络依赖——旧实现直指 8080，启动空窗期
                // 必然先落在 WebView2 的「无法访问此页面」，几乎每次启动都闪一次报错页）。
                // 守卫用 SPA 在 <head> 内联脚本设置的 __RIKKAHUB_APP__ 旗标：旗标在且
                // 端口对 → 页面活着，不打扰；否则（splash 页或端口顺延后的旧页）重导航到
                // 实际端口。splash 页视觉与 SPA 的 HydrateFallback 逐像素一致，用户感知为
                // 一整段连续的品牌启动屏。
                // （更旧的实现只在非 8080 时导航、用 location.href 猜测，修不了 8080 死页。）
                if let Some(window) = wait_handle.get_webview_window("main") {
                    let js = format!(
                        "(function(){{var t='http://localhost:{p}';try{{if(!window.__RIKKAHUB_APP__||location.port!=='{p}'){{location.replace(t)}}}}catch(e){{location.replace(t)}}}})()",
                        p = actual_port
                    );
                    for _ in 0..3 {
                        let _ = window.eval(&js);
                        thread::sleep(Duration::from_millis(700));
                    }
                }
            });

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
                        shutdown_sidecar(&state);
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
                    shutdown_sidecar(&state);
                }
            }
        });
}
