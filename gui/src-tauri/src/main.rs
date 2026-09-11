#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Listener, Manager};

/// The tray is looked up by id whenever its menu has to be rebuilt.
const TRAY_ID: &str = "baton-tray";

/// Parse a `vX.Y.Z` directory name into something sortable.
fn semver_key(name: &str) -> (u64, u64, u64) {
    let mut it = name.trim_start_matches('v').split('.').map(|p| p.parse().unwrap_or(0));
    (it.next().unwrap_or(0), it.next().unwrap_or(0), it.next().unwrap_or(0))
}

/// Newest Node installed by a version manager that keeps versions in one dir.
fn newest_versioned_node(root: PathBuf, suffix: &str) -> Option<PathBuf> {
    let mut versions: Vec<_> = std::fs::read_dir(root)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with('v'))
        .collect();
    versions.sort_by_key(|e| semver_key(&e.file_name().to_string_lossy()));
    versions
        .iter()
        .rev()
        .map(|e| e.path().join(suffix))
        .find(|p| p.is_file())
}

/// Locate the Node binary.
///
/// A macOS app launched from Finder inherits a bare PATH, so a plain
/// `Command::new("node")` fails for everyone using Homebrew or a version
/// manager. Asking a shell is not enough either: nvm and fnm initialise in
/// `.zshrc`, which a login-but-non-interactive shell never sources. So probe
/// the known install locations directly first, and only then fall back to an
/// interactive login shell.
fn resolve_node() -> Result<String, String> {
    // A standalone build ships its own Node beside the executable. Prefer it:
    // it is known-good, and it is the whole reason that build exists.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sidecar = dir.join("node");
            if sidecar.is_file() {
                return Ok(sidecar.to_string_lossy().into_owned());
            }
        }
    }

    if let Ok(explicit) = std::env::var("BATON_NODE") {
        if PathBuf::from(&explicit).is_file() {
            return Ok(explicit);
        }
        return Err(format!("BATON_NODE points at {explicit}, which is not a file"));
    }

    let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin/node"), // Apple silicon Homebrew
        PathBuf::from("/usr/local/bin/node"),    // Intel Homebrew, official pkg
        PathBuf::from("/usr/bin/node"),
        home.join(".volta/bin/node"),
        home.join(".asdf/shims/node"),
    ];
    if let Some(p) = newest_versioned_node(home.join(".nvm/versions/node"), "bin/node") {
        candidates.insert(0, p);
    }
    if let Some(p) = newest_versioned_node(home.join(".local/share/fnm/node-versions"), "installation/bin/node") {
        candidates.insert(0, p);
    }

    if let Some(found) = candidates.iter().find(|p| p.is_file()) {
        return Ok(found.to_string_lossy().into_owned());
    }

    // Last resort: an interactive login shell, which does source .zshrc.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    if let Ok(out) = Command::new(&shell).args(["-lic", "command -v node"]).output() {
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !path.is_empty() && PathBuf::from(&path).is_file() {
            return Ok(path);
        }
    }

    Err(format!(
        "Node.js was not found. Baton needs Node 22.18+.\n\nLooked in: {}\n\nSet BATON_NODE to the output of `which node` if it lives elsewhere.",
        candidates
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(", ")
    ))
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
///
/// The payload comes back whole, an in-band `ok: false` included, because some
/// commands answer a refusal with structure the UI has to render (`remove`
/// returns refusals[]). Callers that only want a value use `run_cli`.
fn cli_json(app: &AppHandle, args: &[&str]) -> Result<Value, String> {
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

    Ok(parsed)
}

/// Run the CLI and treat its in-band failure as an error, so the message lands
/// in the UI's error path instead of being mistaken for a result.
fn run_cli(app: &AppHandle, args: &[&str]) -> Result<Value, String> {
    let parsed = cli_json(app, args)?;
    if parsed.get("ok") == Some(&Value::Bool(false)) {
        return Err(parsed
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown error")
            .to_string());
    }
    Ok(parsed)
}

/// Quote one argument for a POSIX shell. Account directories and the bundle's
/// Resources path both routinely contain spaces.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Escape a string for an AppleScript double-quoted literal.
fn applescript_quote(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Hand a ready-made shell command to Terminal.app.
fn open_terminal(command: &str) -> Result<(), String> {
    let script = format!(
        r#"tell application "Terminal"
            activate
            do script "{}"
        end tell"#,
        applescript_quote(command)
    );
    let status = Command::new("osascript")
        .args(["-e", &script])
        .status()
        .map_err(|e| format!("could not open Terminal: {e}"))?;
    if !status.success() {
        return Err("Terminal refused to run the command. Is it blocked by automation permissions?".into());
    }
    Ok(())
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
fn settings(app: AppHandle) -> Result<Value, String> {
    run_cli(&app, &["settings"])
}

#[tauri::command]
fn set_setting(app: AppHandle, key: String, value: String) -> Result<Value, String> {
    run_cli(&app, &["settings", "set", key.as_str(), value.as_str()])
}

#[tauri::command]
fn add_account(app: AppHandle, name: String) -> Result<Value, String> {
    let result = run_cli(&app, &["add", name.as_str()])?;
    let _ = app.emit("accounts-changed", ());
    Ok(result)
}

#[tauri::command]
fn history(
    app: AppHandle,
    search: Option<String>,
    project: Option<String>,
    from: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Value, String> {
    let mut args: Vec<String> = vec!["history".into()];
    if let Some(v) = search.filter(|v| !v.is_empty()) { args.push("--search".into()); args.push(v); }
    if let Some(v) = project.filter(|v| !v.is_empty()) { args.push("--project".into()); args.push(v); }
    if let Some(v) = from.filter(|v| !v.is_empty()) { args.push("--from".into()); args.push(v); }
    // Dropping these pinned every request to the CLI's own first page, so
    // "Load more" re-fetched the same rows and the view turned paging off.
    if let Some(v) = limit { args.push("--limit".into()); args.push(v.to_string()); }
    if let Some(v) = offset { args.push("--offset".into()); args.push(v.to_string()); }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_cli(&app, &refs)
}

#[tauri::command]
fn autoswitch(app: AppHandle) -> Result<Value, String> {
    let result = run_cli(&app, &["autoswitch"])?;
    if result.get("acted") == Some(&Value::Bool(true)) {
        let _ = app.emit("accounts-changed", ());
    }
    Ok(result)
}

#[tauri::command]
fn doctor(app: AppHandle) -> Result<Value, String> {
    run_cli(&app, &["doctor"])
}

/// Open a terminal sitting at the login command, so adding an account does not
/// mean copying a path by hand.
#[tauri::command]
fn open_login_terminal(command: String) -> Result<(), String> {
    open_terminal(&command)
}

/// Open a terminal already bound to an account, via the CLI's own `shell`.
#[tauri::command]
fn open_terminal_on_account(app: AppHandle, account: String) -> Result<(), String> {
    let node = resolve_node()?;
    let cli = cli_path(&app)?;
    let command = format!(
        "{} {} shell {}",
        sh_quote(&node),
        sh_quote(&cli.to_string_lossy()),
        sh_quote(&account)
    );
    open_terminal(&command)
}

/// Reveal a path in the platform file manager.
///
/// "Reveal" means select the item inside its folder, not open it: a config
/// directory opened is a window full of dotfiles, a snapshot opened is a
/// tarball handed to Archive Utility.
#[tauri::command]
fn open_in_finder(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("{path} is no longer there"));
    }

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg("-R").arg(&target);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("explorer");
        c.arg(format!("/select,{}", target.display()));
        c
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut cmd = {
        // No file manager here agrees on how to select an item, so settle for
        // opening the folder that contains it.
        let dir = target.parent().unwrap_or(&target).to_path_buf();
        let mut c = Command::new("xdg-open");
        c.arg(dir);
        c
    };

    let status = cmd
        .status()
        .map_err(|e| format!("could not open the file manager: {e}"))?;
    // explorer.exe exits non-zero even when it did reveal the file, so its
    // status says nothing worth reporting.
    #[cfg(not(target_os = "windows"))]
    if !status.success() {
        return Err(format!("the file manager refused to reveal {path}"));
    }
    #[cfg(target_os = "windows")]
    let _ = status;
    Ok(())
}

#[tauri::command]
fn accounts(app: AppHandle) -> Result<Value, String> {
    run_cli(&app, &["accounts"])
}

#[tauri::command]
fn reauth_command(app: AppHandle, account: String) -> Result<Value, String> {
    run_cli(&app, &["reauth", account.as_str()])
}

/// Remove an account, or report why the CLI will not.
///
/// This one deliberately bypasses `run_cli`: a refusal arrives as
/// `{ok: false, refusals: [...]}`, and each refusal carries a code, a message
/// and whether --force can override it. Collapsing that to an error string
/// would leave the UI with nothing to offer but the text.
#[tauri::command]
fn remove_account(
    app: AppHandle,
    account: String,
    delete_history: bool,
    force: bool,
    dry_run: bool,
) -> Result<Value, String> {
    let mut args: Vec<&str> = vec!["remove", account.as_str()];
    if delete_history {
        args.push("--delete-history");
    }
    if force {
        args.push("--force");
    }
    if dry_run {
        args.push("--dry-run");
    }

    let result = cli_json(&app, &args)?;
    // A refusal or a dry run changed nothing, so nothing has to refresh.
    if result.get("ok") == Some(&Value::Bool(true)) && !dry_run {
        let _ = app.emit("accounts-changed", ());
    }
    Ok(result)
}

#[tauri::command]
fn health(app: AppHandle) -> Result<Value, String> {
    run_cli(&app, &["health"])
}

#[tauri::command]
fn sessions(app: AppHandle) -> Result<Value, String> {
    run_cli(&app, &["sessions"])
}

#[tauri::command]
fn usage_report(app: AppHandle) -> Result<Value, String> {
    run_cli(&app, &["usage"])
}

#[tauri::command]
fn backups_list(app: AppHandle) -> Result<Value, String> {
    run_cli(&app, &["backups"])
}

#[tauri::command]
fn backups_prune(app: AppHandle, dry_run: bool) -> Result<Value, String> {
    let mut args = vec!["backups", "prune"];
    if dry_run {
        args.push("--dry-run");
    }
    let result = run_cli(&app, &args)?;
    if !dry_run {
        let _ = app.emit("accounts-changed", ());
    }
    Ok(result)
}

#[tauri::command]
fn backups_restore(app: AppHandle, id: String, dry_run: bool) -> Result<Value, String> {
    let mut args = vec!["backups", "restore", id.as_str()];
    if dry_run {
        args.push("--dry-run");
    }
    let result = run_cli(&app, &args)?;
    // A restore can put a whole account back, so the tray and the window both
    // need to look again.
    if !dry_run {
        let _ = app.emit("accounts-changed", ());
    }
    Ok(result)
}

#[tauri::command]
fn preflight(app: AppHandle) -> Result<Value, String> {
    run_cli(&app, &["preflight"])
}

/// Set or clear an account's display name. An empty alias clears it, which is
/// what the CLI does with an empty positional.
#[tauri::command]
fn set_alias(app: AppHandle, account: String, alias: String) -> Result<Value, String> {
    let result = run_cli(&app, &["alias", account.as_str(), alias.as_str()])?;
    let _ = app.emit("accounts-changed", ());
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

/// One row of the tray's account list.
struct TrayAccount {
    id: String,
    label: String,
}

/// Read the account list the tray shows, marking the ones an editor is bound to.
///
/// Failure is deliberately quiet here: the tray is a menu, not a report. An
/// empty list becomes a "No accounts found" row rather than no menu at all.
fn tray_accounts(app: &AppHandle) -> Vec<TrayAccount> {
    let Ok(status) = status(app.clone()) else {
        return Vec::new();
    };
    let list = status
        .get("providers")
        .and_then(Value::as_array)
        .and_then(|providers| providers.first())
        .and_then(|provider| provider.get("accounts"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    list.iter()
        .filter_map(|a| {
            let id = a.get("id")?.as_str()?.to_string();
            let name = a
                .get("displayName")
                .and_then(Value::as_str)
                .unwrap_or(id.as_str());
            // displayEmail already spells out "not logged in" when there is no
            // credential, which is the answer a blank would have hidden.
            let email = a
                .get("displayEmail")
                .or_else(|| a.get("email"))
                .and_then(Value::as_str)
                .unwrap_or("not logged in");
            // usedBy lists the editors currently pointed at this account, so a
            // non-empty list is what "current" means.
            let in_use = a
                .get("usedBy")
                .and_then(Value::as_array)
                .is_some_and(|hosts| !hosts.is_empty());
            let mark = if in_use { "• " } else { "   " };
            Some(TrayAccount { label: format!("{mark}{name}  ({email})"), id })
        })
        .collect()
}

/// Build the tray menu from an account list already read off the main thread.
fn tray_menu(app: &AppHandle, accounts: &[TrayAccount]) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    for account in accounts {
        menu.append(&MenuItem::with_id(
            app,
            format!("use:{}", account.id),
            &account.label,
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
    Ok(menu)
}

/// Create the tray icon and give it its first menu.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = tray_menu(app, &tray_accounts(app))?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref().to_string();
            if let Some(account) = id.strip_prefix("use:") {
                // switch_account emits accounts-changed itself, which is what
                // rebuilds this menu.
                if let Err(e) = switch_account(app.clone(), account.to_string(), None) {
                    let _ = app.emit("baton-error", e);
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

/// Rebuild the tray menu after something changed underneath it.
///
/// The list comes from the CLI, which is a process spawn — far too slow to run
/// on the main thread, where it would freeze the menu mid-click. Menus are a
/// main-thread resource though, so read off-thread and apply back on it.
fn refresh_tray(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let accounts = tray_accounts(&app);
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(tray) = handle.tray_by_id(TRAY_ID) else {
                return;
            };
            match tray_menu(&handle, &accounts) {
                Ok(menu) => {
                    let _ = tray.set_menu(Some(menu));
                }
                // Leave the old menu in place: stale rows still switch
                // accounts, whereas a tray with no menu does nothing at all.
                Err(e) => {
                    let _ = handle.emit("baton-error", format!("could not refresh the tray menu: {e}"));
                }
            }
        });
    });
}

// Aliases matching the CLI's own spelling, which is what the frontend uses.
// Keeping both means neither side has to churn when the other is edited.
#[tauri::command]
fn usage(app: AppHandle) -> Result<Value, String> {
    usage_report(app)
}

#[tauri::command]
fn backups(app: AppHandle) -> Result<Value, String> {
    backups_list(app)
}

/// Record which account a limit belonged to, when Baton could not tell.
#[tauri::command]
fn blame_limit(app: AppHandle, account: String) -> Result<Value, String> {
    let result = run_cli(&app, &["limit", account.as_str()])?;
    let _ = app.emit("accounts-changed", ());
    Ok(result)
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    open_in_finder(path)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            status,
            accounts,
            switch_account,
            preview_link,
            apply_link,
            settings,
            set_setting,
            set_alias,
            add_account,
            remove_account,
            reauth_command,
            health,
            sessions,
            usage_report,
            backups_list,
            backups_prune,
            backups_restore,
            preflight,
            doctor,
            history,
            autoswitch,
            open_login_terminal,
            open_terminal_on_account,
            usage,
            backups,
            reveal_path,
            blame_limit,
            open_in_finder
        ])
        .setup(|app| {
            build_tray(app.handle())?;
            // The menu used to be built once and then went stale: it never
            // followed a switch, a rename or a removal. Every mutation emits
            // accounts-changed, so rebuild on it.
            let handle = app.handle().clone();
            app.listen("accounts-changed", move |_| refresh_tray(&handle));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Baton");
}
