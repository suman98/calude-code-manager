// Easy Switch — a project launcher that runs the Claude Code VS Code extension
// inside the app.
//
// The Rust side owns:
//   1. a small JSON store of tracked projects (recents + favorites)
//   2. one local `code serve-web` instance; projects open as ?folder= URLs
//      (see `vscode.rs`)
//   3. discovering projects VS Code already knows about, for one-click import

mod sessions;
mod vscode;

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

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
    });
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
    if let Some(p) = store.projects.iter_mut().find(|p| p.path == path) {
        p.favorite = !p.favorite;
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
            get_limits,
            set_limits,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
