// Easy Switch — a project launcher that runs the Claude Code VS Code extension
// inside the app.
//
// The Rust side owns:
//   1. a small JSON store of tracked projects (recents + favorites)
//   2. one local `code serve-web` instance; projects open as ?folder= URLs
//      (see `vscode.rs`)
//   3. discovering projects VS Code already knows about, for one-click import

mod accounts;
mod sessions;
mod usage;
mod vscode;

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Project {
    path: String,
    name: String,
    #[serde(default)]
    favorite: bool,
    #[serde(default)]
    last_opened: Option<u64>,
    #[serde(default)]
    added: u64,
    #[serde(default)]
    open_count: u32,
    /// hex accent colour chosen by the user, e.g. "#f38ec4"
    #[serde(default)]
    color: Option<String>,
    /// custom icon as a `data:image/png;base64,…` URL
    #[serde(default)]
    icon: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Default, Debug)]
struct Limits {
    /// tokens the user's plan allows per rolling 5-hour window
    session_tokens: Option<u64>,
    /// tokens the user's plan allows per rolling 7-day window
    weekly_tokens: Option<u64>,
}

#[derive(Serialize, Deserialize, Default)]
struct Store {
    projects: Vec<Project>,
    #[serde(default)]
    limits: Limits,
    /// Registered Claude accounts. Labels only — tokens live in the keychain.
    #[serde(default)]
    accounts: Vec<accounts::Account>,
    /// id of the account in use; `None` runs on the Claude Code keychain login
    #[serde(default)]
    active_account: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
struct Discovered {
    path: String,
    name: String,
    already_added: bool,
    modified: u64,
}

struct AppState {
    store_path: PathBuf,
    store: Mutex<Store>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn dir_mtime_ms(p: &Path) -> u64 {
    fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn basename(p: &str) -> String {
    Path::new(p)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| p.trim_matches('/').to_string())
}

/// Trim trailing separators and expand a leading `~`.
fn normalize(path: &str) -> String {
    let expanded = if let Some(rest) = path.strip_prefix("~/") {
        dirs::home_dir()
            .map(|h| h.join(rest).to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string())
    } else {
        path.to_string()
    };
    let trimmed = expanded.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

fn minimal_percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn load_store(path: &Path) -> Store {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_store(path: &Path, store: &Store) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn vscode_storage_json() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let candidates = [
        home.join("Library/Application Support/Code/User/globalStorage/storage.json"),
        home.join(".config/Code/User/globalStorage/storage.json"),
        home.join("AppData/Roaming/Code/User/globalStorage/storage.json"),
    ];
    candidates.into_iter().find(|p| p.exists())
}

// ── project store commands ───────────────────────────────────────────────────

#[tauri::command]
fn list_projects(state: State<AppState>) -> Vec<Project> {
    state.store.lock().unwrap().projects.clone()
}

fn upsert_new(store: &mut Store, path: &str, opened: bool) {
    if store.projects.iter().any(|p| p.path == path) {
        return;
    }
    store.projects.push(Project {
        name: basename(path),
        path: path.to_string(),
        favorite: false,
        last_opened: if opened { Some(now_ms()) } else { None },
        added: now_ms(),
        open_count: if opened { 1 } else { 0 },
        color: None,
        icon: None,
    });
}

/// Index where the favourites block ends (== the first non-favourite).
fn favorites_boundary(store: &Store) -> usize {
    store
        .projects
        .iter()
        .position(|p| !p.favorite)
        .unwrap_or(store.projects.len())
}

#[tauri::command]
fn add_project(path: String, state: State<AppState>) -> Result<Vec<Project>, String> {
    let path = normalize(&path);
    if !Path::new(&path).is_dir() {
        return Err(format!("Not a folder: {path}"));
    }
    let mut store = state.store.lock().unwrap();
    upsert_new(&mut store, &path, false);
    save_store(&state.store_path, &store)?;
    Ok(store.projects.clone())
}

#[tauri::command]
fn add_projects(paths: Vec<String>, state: State<AppState>) -> Result<Vec<Project>, String> {
    let mut store = state.store.lock().unwrap();
    for raw in paths {
        let path = normalize(&raw);
        if Path::new(&path).is_dir() {
            upsert_new(&mut store, &path, false);
        }
    }
    save_store(&state.store_path, &store)?;
    Ok(store.projects.clone())
}

#[tauri::command]
fn remove_project(path: String, state: State<AppState>) -> Result<Vec<Project>, String> {
    let mut store = state.store.lock().unwrap();
    store.projects.retain(|p| p.path != path);
    save_store(&state.store_path, &store)?;
    Ok(store.projects.clone())
}

#[tauri::command]
fn toggle_favorite(path: String, state: State<AppState>) -> Result<Vec<Project>, String> {
    let mut store = state.store.lock().unwrap();
    if let Some(idx) = store.projects.iter().position(|p| p.path == path) {
        let mut proj = store.projects.remove(idx);
        proj.favorite = !proj.favorite;
        // Favourited → bottom of the favourites block; unfavourited → top of the
        // rest. Both land at the favourites/others boundary.
        let at = favorites_boundary(&store);
        store.projects.insert(at, proj);
    }
    save_store(&state.store_path, &store)?;
    Ok(store.projects.clone())
}

/// Set the manual order of every project. Unknown paths are ignored; any project
/// missing from `order` keeps its relative place at the end.
#[tauri::command]
fn reorder_projects(order: Vec<String>, state: State<AppState>) -> Result<Vec<Project>, String> {
    let rank: std::collections::HashMap<String, usize> =
        order.into_iter().enumerate().map(|(i, p)| (p, i)).collect();
    let mut store = state.store.lock().unwrap();
    store
        .projects
        .sort_by_key(|p| *rank.get(&p.path).unwrap_or(&usize::MAX));
    save_store(&state.store_path, &store)?;
    Ok(store.projects.clone())
}

#[tauri::command]
fn set_project_color(
    path: String,
    color: Option<String>,
    state: State<AppState>,
) -> Result<Vec<Project>, String> {
    let color = color.filter(|c| {
        c.starts_with('#')
            && (c.len() == 4 || c.len() == 7)
            && c[1..].chars().all(|ch| ch.is_ascii_hexdigit())
    });
    let mut store = state.store.lock().unwrap();
    if let Some(p) = store.projects.iter_mut().find(|p| p.path == path) {
        p.color = color;
    }
    save_store(&state.store_path, &store)?;
    Ok(store.projects.clone())
}

// ── Claude account switching ────────────────────────────────────────────────

/// The token Claude Code should run with, or `None` for the keychain login.
pub fn active_token(app: &tauri::AppHandle) -> Option<String> {
    let state = app.state::<AppState>();
    let id = state.store.lock().unwrap().active_account.clone()?;
    accounts::read_token(&id)
}

#[tauri::command]
fn account_state(state: State<AppState>) -> accounts::AccountState {
    let store = state.store.lock().unwrap();
    accounts::AccountState {
        accounts: store.accounts.clone(),
        active: store.active_account.clone(),
    }
}

#[tauri::command]
fn add_account(
    label: String,
    token: String,
    state: State<AppState>,
) -> Result<accounts::AccountState, String> {
    let token = token.trim().to_string();
    if !token.starts_with("sk-ant-") {
        return Err("That does not look like a Claude OAuth token (sk-ant-…).".into());
    }
    let id = format!("acct-{}", now_ms());
    let hint = accounts::store_token(&id, &token)?;

    let mut store = state.store.lock().unwrap();
    let label = if label.trim().is_empty() {
        format!("Token {}", store.accounts.len() + 1)
    } else {
        label.trim().to_string()
    };
    store.accounts.push(accounts::Account { id, label, hint });
    save_store(&state.store_path, &store)?;
    Ok(accounts::AccountState {
        accounts: store.accounts.clone(),
        active: store.active_account.clone(),
    })
}

#[tauri::command]
fn remove_account(id: String, state: State<AppState>) -> Result<accounts::AccountState, String> {
    accounts::forget_token(&id);
    let mut store = state.store.lock().unwrap();
    store.accounts.retain(|a| a.id != id);
    if store.active_account.as_deref() == Some(id.as_str()) {
        store.active_account = None;
    }
    save_store(&state.store_path, &store)?;
    Ok(accounts::AccountState {
        accounts: store.accounts.clone(),
        active: store.active_account.clone(),
    })
}

/// Switch accounts. The caller restarts the VS Code server, since the token is
/// read from the environment at spawn time.
#[tauri::command]
fn set_active_account(
    id: Option<String>,
    state: State<AppState>,
) -> Result<accounts::AccountState, String> {
    let mut store = state.store.lock().unwrap();
    if let Some(want) = id.as_deref() {
        if !store.accounts.iter().any(|a| a.id == want) {
            return Err("No such account".into());
        }
        if accounts::read_token(want).is_none() {
            return Err("That account's token is no longer in the keychain.".into());
        }
    }
    store.active_account = id;
    save_store(&state.store_path, &store)?;
    Ok(accounts::AccountState {
        accounts: store.accounts.clone(),
        active: store.active_account.clone(),
    })
}

/// Tokens already exported in the user's shell profile, so they can be adopted
/// with one click instead of pasted.
#[tauri::command]
fn discover_shell_accounts(state: State<AppState>) -> Vec<String> {
    let known: Vec<String> = state
        .store
        .lock()
        .unwrap()
        .accounts
        .iter()
        .map(|a| a.hint.clone())
        .collect();
    accounts::scan_shell_profiles()
        .into_iter()
        .filter(|(_, token)| !known.contains(&accounts::hint_for(token)))
        .map(|(label, _)| label)
        .collect()
}

/// Register a shell-profile token by its label. The token is copied straight
/// into the keychain; it is never handed to the frontend.
#[tauri::command]
fn adopt_shell_account(
    label: String,
    name: String,
    state: State<AppState>,
) -> Result<accounts::AccountState, String> {
    let (_, token) = accounts::scan_shell_profiles()
        .into_iter()
        .find(|(l, _)| *l == label)
        .ok_or("That shell token is no longer there")?;

    let id = format!("acct-{}", now_ms());
    let hint = accounts::store_token(&id, &token)?;
    let mut store = state.store.lock().unwrap();
    let label = if name.trim().is_empty() {
        format!("Token {}", store.accounts.len() + 1)
    } else {
        name.trim().to_string()
    };
    store.accounts.push(accounts::Account { id, label, hint });
    save_store(&state.store_path, &store)?;
    Ok(accounts::AccountState {
        accounts: store.accounts.clone(),
        active: store.active_account.clone(),
    })
}

/// Load an image file, square-crop and shrink it to 128px, and store it on the
/// project as an inline PNG data URL.
#[tauri::command]
fn set_project_icon(
    path: String,
    source: String,
    state: State<AppState>,
) -> Result<Vec<Project>, String> {
    let bytes = fs::read(&source).map_err(|e| format!("Could not read image: {e}"))?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("Image is too large (max 16 MB).".to_string());
    }
    let img = image::load_from_memory(&bytes).map_err(|_| "That file is not a readable image.".to_string())?;
    let icon = img.resize_to_fill(128, 128, image::imageops::FilterType::Lanczos3);

    let mut png: Vec<u8> = Vec::new();
    icon.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let data_url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&png)
    );

    let mut store = state.store.lock().unwrap();
    if let Some(p) = store.projects.iter_mut().find(|p| p.path == path) {
        p.icon = Some(data_url);
    }
    save_store(&state.store_path, &store)?;
    Ok(store.projects.clone())
}

#[tauri::command]
fn clear_project_icon(path: String, state: State<AppState>) -> Result<Vec<Project>, String> {
    let mut store = state.store.lock().unwrap();
    if let Some(p) = store.projects.iter_mut().find(|p| p.path == path) {
        p.icon = None;
    }
    save_store(&state.store_path, &store)?;
    Ok(store.projects.clone())
}

/// Mark a project as the one the user just switched to (bumps recency).
#[tauri::command]
fn touch_project(path: String, state: State<AppState>) -> Result<Vec<Project>, String> {
    let path = normalize(&path);
    let mut store = state.store.lock().unwrap();
    match store.projects.iter_mut().find(|p| p.path == path) {
        Some(p) => {
            p.last_opened = Some(now_ms());
            p.open_count += 1;
        }
        None => upsert_new(&mut store, &path, true),
    }
    save_store(&state.store_path, &store)?;
    Ok(store.projects.clone())
}

#[tauri::command]
fn get_limits(state: State<AppState>) -> Limits {
    state.store.lock().unwrap().limits
}

#[tauri::command]
fn set_limits(
    session_tokens: Option<u64>,
    weekly_tokens: Option<u64>,
    state: State<AppState>,
) -> Result<Limits, String> {
    let mut store = state.store.lock().unwrap();
    store.limits = Limits {
        session_tokens: session_tokens.filter(|v| *v > 0),
        weekly_tokens: weekly_tokens.filter(|v| *v > 0),
    };
    save_store(&state.store_path, &store)?;
    Ok(store.limits)
}

#[tauri::command]
fn reveal_in_file_manager(path: String) -> Result<(), String> {
    let path = normalize(&path);
    #[cfg(target_os = "macos")]
    let (cmd, args): (&str, Vec<&str>) = ("open", vec![path.as_str()]);
    #[cfg(target_os = "windows")]
    let (cmd, args): (&str, Vec<&str>) = ("explorer", vec![path.as_str()]);
    #[cfg(all(unix, not(target_os = "macos")))]
    let (cmd, args): (&str, Vec<&str>) = ("xdg-open", vec![path.as_str()]);
    Command::new(cmd)
        .args(&args)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Read the folders VSCode already knows about (from its `storage.json`) so the
/// user can bulk-import them. Only folders that still exist on disk are returned,
/// newest-modified first. Multi-root `.code-workspace` files are skipped.
#[tauri::command]
fn discover_vscode_projects(state: State<AppState>) -> Result<Vec<Discovered>, String> {
    let json_path = vscode_storage_json()
        .ok_or_else(|| "Could not find VSCode's storage.json — is VSCode installed?".to_string())?;
    let text = fs::read_to_string(&json_path).map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;

    let known: HashSet<String> = {
        let store = state.store.lock().unwrap();
        store.projects.iter().map(|p| p.path.clone()).collect()
    };

    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<Discovered> = Vec::new();

    let mut consider = |uri: &str| {
        let Some(fp) = uri.strip_prefix("file://") else {
            return;
        };
        let decoded = minimal_percent_decode(fp);
        if decoded.ends_with(".code-workspace") {
            return;
        }
        let pb = PathBuf::from(&decoded);
        if !pb.is_dir() || !seen.insert(decoded.clone()) {
            return;
        }
        out.push(Discovered {
            name: basename(&decoded),
            already_added: known.contains(&decoded),
            modified: dir_mtime_ms(&pb),
            path: decoded,
        });
    };

    if let Some(ws) = json
        .pointer("/profileAssociations/workspaces")
        .and_then(|v| v.as_object())
    {
        for uri in ws.keys() {
            consider(uri);
        }
    }
    if let Some(folders) = json
        .pointer("/backupWorkspaces/folders")
        .and_then(|v| v.as_array())
    {
        for f in folders {
            if let Some(u) = f.get("folderUri").and_then(|v| v.as_str()) {
                consider(u);
            }
        }
    }

    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(path: &str, fav: bool) -> Project {
        Project {
            path: path.into(),
            name: basename(path),
            favorite: fav,
            last_opened: None,
            added: 0,
            open_count: 0,
            color: None,
            icon: None,
        }
    }

    fn paths(store: &Store) -> Vec<&str> {
        store.projects.iter().map(|p| p.path.as_str()).collect()
    }

    #[test]
    fn reorder_applies_given_order_and_keeps_unlisted_at_end() {
        let mut store = Store::default();
        store.projects = vec![p("a", false), p("b", false), p("c", false), p("d", false)];

        let rank: std::collections::HashMap<String, usize> = ["c", "a", "b"]
            .iter()
            .enumerate()
            .map(|(i, s)| (s.to_string(), i))
            .collect();
        store
            .projects
            .sort_by_key(|p| *rank.get(&p.path).unwrap_or(&usize::MAX));

        assert_eq!(paths(&store), ["c", "a", "b", "d"]);
    }

    #[test]
    fn favouriting_moves_to_end_of_favourites_block() {
        let mut store = Store::default();
        store.projects = vec![p("f1", true), p("f2", true), p("x", false), p("y", false)];

        // favourite "y"
        let idx = store.projects.iter().position(|p| p.path == "y").unwrap();
        let mut proj = store.projects.remove(idx);
        proj.favorite = true;
        let at = favorites_boundary(&store);
        store.projects.insert(at, proj);
        assert_eq!(paths(&store), ["f1", "f2", "y", "x"]);

        // unfavourite "f1" → top of the others block
        let idx = store.projects.iter().position(|p| p.path == "f1").unwrap();
        let mut proj = store.projects.remove(idx);
        proj.favorite = false;
        let at = favorites_boundary(&store);
        store.projects.insert(at, proj);
        assert_eq!(paths(&store), ["f2", "y", "f1", "x"]);
    }
}

// ── setup ─────────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(vscode::Vscode::default())
        .manage(sessions::Sessions::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let vscode = window.state::<vscode::Vscode>();
                vscode::stop_server(vscode);
            }
        })
        .setup(|app| {
            let config_dir = app
                .path()
                .app_config_dir()
                .expect("resolvable app config dir");
            let store_path = config_dir.join("projects.json");
            let store = load_store(&store_path);
            app.manage(AppState {
                store_path,
                store: Mutex::new(store),
            });

            // Global hotkey: summon the switcher from anywhere.
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
                let handle = app.handle().clone();
                let summon = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyO);
                let _ = app
                    .global_shortcut()
                    .on_shortcut(summon, move |_app, _sc, event| {
                        if event.state() == ShortcutState::Pressed {
                            if let Some(w) = handle.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                            }
                        }
                    });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_projects,
            add_project,
            add_projects,
            remove_project,
            toggle_favorite,
            reorder_projects,
            set_project_color,
            set_project_icon,
            clear_project_icon,
            touch_project,
            reveal_in_file_manager,
            discover_vscode_projects,
            vscode::server_status,
            vscode::ensure_server,
            vscode::folder_url,
            vscode::stop_server,
            vscode::mount_vscode,
            vscode::set_vscode_bounds,
            vscode::hide_vscode,
            vscode::close_vscode,
            vscode::send_vscode_command,
            vscode::set_vscode_mode,
            vscode::get_vscode_mode,
            sessions::list_sessions,
            sessions::project_usage,
            sessions::usage_overview,
            sessions::usage_windows,
            usage::claude_usage,
            account_state,
            add_account,
            remove_account,
            set_active_account,
            discover_shell_accounts,
            adopt_shell_account,
            get_limits,
            set_limits,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
