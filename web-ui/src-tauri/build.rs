fn main() {
    // 显式声明 app 自定义 command,让 Tauri 为它们生成 ACL permission(<crate>:allow-<command>),
    // 这样远程 URL webview(前端从 http://localhost:8080 加载)才能在 capability 里放行 invoke。
    // 裸 tauri_build::build() 不会扫描 #[tauri::command],launch_installer 等会被 ACL 拒绝。
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["get_data_dir", "set_data_dir", "launch_installer"]),
        ),
    )
    .expect("tauri build failed");
}
