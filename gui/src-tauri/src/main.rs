#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

/// Locate the Node binary.
///
/// A macOS app launched from Finder inherits a bare PATH (`/usr/bin:/bin:...`),
/// so Homebrew, nvm and fnm installs are all invisible to a plain `Command::new("node")`.
/// Asking a login shell is the only reliable way to get the user's real PATH.
fn resolve_node() -> Result<String, String> {
    if let Ok(explicit) = std::env::var("BATON_NODE") {
        return Ok(explicit);
    }

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let out = Command::new(&shell)
        .args(["-lc", "command -v node"])
        .output()
        .map_err(|e| format!("could not start {shell}: {e}"))?;

    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        return Err(
            "Node.js was not found. Baton needs Node 22.18+ on your PATH, or set BATON_NODE."
                .into(),
        );
    }
    Ok(path)
}

/// Path to the bundled CLI, or an override for development.
fn cli_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(dev) = std::env::var("BATON_CLI") {
        return Ok(PathBuf::from(dev));
    }
    app.path()
        .resolve("cli.mjs", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("bundled CLI missing: {e}"))
}

/// Run the CLI in --json mode and parse what it prints.
fn run_cli(app: &AppHandle, args: &[&str]) -> Result<Value, String> {
    let node = resolve_node()?;
    let cli = cli_path(app)?;

    let mut argv: Vec<String> = vec![cli.to_string_lossy().into_owned()];
    argv.extend(args.iter().map(|s| s.to_string()));
    argv.push("--json".into());

    let out = Command::new(&node)
        .args(&argv)
        .output()
        .map_err(|e| format!("failed to run the Baton CLI: {e}"))?;

    let stdout = String::from_utf8_lossy(&out.stdout);
    let parsed: Value = serde_json::from_str(stdout.trim()).map_err(|_| {
        let stderr = String::from_utf8_lossy(&out.stderr);
        format!(
            "unexpected CLI output: {}",
            if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() }
        )
    })?;

    // The CLI reports its own failures in-band so the message survives.
    if parsed.get("ok") == Some(&Value::Bool(false)) {
        return Err(parsed
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown error")
            .to_string());
    }
    Ok(parsed)
}

#[tauri::command]
fn status(app: AppHandle) -> Result<Value, String> {
    run_cli(&app, &["status"])
}

#[tauri::command]
fn switch_account(app: AppHandle, account: String, host: Option<String>) -> Result<Value, String> {
    let mut args = vec!["use", account.as_str()];
    match host.as_deref() {
        Some(h) => args.extend_from_slice(&["--host", h]),
        None => args.push("--all"),
    }
    let result = run_cli(&app, &args)?;
    let _ = app.emit("accounts-changed", &result);
    Ok(result)
}

#[tauri::command]
fn preview_link(app: AppHandle) -> Result<Value, String> {
    run_cli(&app, &["link", "--all", "--dry-run"])
}

#[tauri::command]
fn apply_link(app: AppHandle) -> Result<Value, String> {
    let result = run_cli(&app, &["link", "--all"])?;
    let _ = app.emit("accounts-changed", &result);
    Ok(result)
}

/// Build the tray menu from whatever accounts currently exist.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let accounts: Vec<(String, String)> = status(app.clone())
        .ok()
        .and_then(|v| {
            let providers = v.get("providers")?.as_array()?.clone();
            let first = providers.first()?.clone();
            let list = first.get("accounts")?.as_array()?.clone();
            Some(
                list.iter()
                    .filter_map(|a| {
                        let id = a.get("id")?.as_str()?.to_string();
                        let email = a
                            .get("email")
                            .and_then(Value::as_str)
                            .unwrap_or("not logged in")
                            .to_string();
                        Some((id, email))
                    })
                    .collect(),
            )
        })
        .unwrap_or_default();

    let menu = Menu::new(app)?;
    for (id, email) in &accounts {
        menu.append(&MenuItem::with_id(
            app,
            format!("use:{id}"),
            format!("Switch to {id}  ({email})"),
            true,
            None::<&str>,
        )?)?;
    }
    if accounts.is_empty() {
        menu.append(&MenuItem::with_id(app, "none", "No accounts found", false, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "open", "Open Baton…", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&PredefinedMenuItem::quit(app, Some("Quit Baton"))?)?;

    TrayIconBuilder::with_id("baton-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref().to_string();
            if let Some(account) = id.strip_prefix("use:") {
                match switch_account(app.clone(), account.to_string(), None) {
                    Ok(_) => {
                        let _ = app.emit("accounts-changed", ());
                    }
                    Err(e) => {
                        let _ = app.emit("baton-error", e);
                    }
                }
            } else if id == "open" {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            status,
            switch_account,
            preview_link,
            apply_link
        ])
        .setup(|app| {
            build_tray(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Baton");
}
