// Runs one local `code serve-web` instance (VS Code for the Web, served from the
// user's installed VS Code). Projects open as `?folder=<path>` URLs inside it,
// so the real Claude Code extension UI runs in the app.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::webview::WebviewBuilder;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Webview, WebviewUrl,
};

#[derive(Clone, Serialize, Default)]
pub struct ServerStatus {
    /// idle | starting | ready | error
    pub phase: String,
    pub message: String,
    pub port: Option<u16>,
}

struct Running {
    child: Child,
    port: u16,
}

#[derive(Default)]
pub struct Vscode {
    running: Mutex<Option<Running>>,
    status: Mutex<ServerStatus>,
    booting: Mutex<bool>,
    /// one child webview per project path
    views: Mutex<HashMap<String, Webview>>,
    /// project path of the currently shown child webview
    visible: Mutex<Option<String>>,
}

impl Vscode {
    fn set_status(&self, app: &AppHandle, phase: &str, message: &str, port: Option<u16>) {
        let s = ServerStatus {
            phase: phase.to_string(),
            message: message.to_string(),
            port,
        };
        *self.status.lock().unwrap() = s.clone();
        let _ = app.emit("vscode:status", s);
    }
}

fn vscode_cli() -> Option<PathBuf> {
    let candidates = [
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
        "/Applications/VSCodium.app/Contents/Resources/app/bin/codium",
        "/usr/share/code/bin/code",
        "/usr/bin/code",
        "/opt/homebrew/bin/code",
        "/usr/local/bin/code",
    ];
    for c in candidates {
        let p = PathBuf::from(c);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(23100)
}

fn server_data_dir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("vscode-web");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn health_ok(port: u16) -> bool {
    // Cheap check: open a TCP connection and send a HEAD, look for "HTTP/1.1".
    use std::io::{Read, Write};
    let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    let mut buf = [0u8; 32];
    match stream.read(&mut buf) {
        // 202 means the server component is still downloading; only 200 is ready.
        Ok(n) if n > 0 => buf.starts_with(b"HTTP/1.1 200"),
        _ => false,
    }
}

#[tauri::command]
pub fn server_status(vscode: State<Vscode>) -> ServerStatus {
    vscode.status.lock().unwrap().clone()
}

#[tauri::command]
pub fn folder_url(vscode: State<Vscode>, path: String) -> Result<String, String> {
    let guard = vscode.status.lock().unwrap();
    let port = guard.port.ok_or("VS Code server is not ready")?;
    Ok(format!(
        "http://127.0.0.1:{port}/?folder={}",
        encode_path(&path)
    ))
}

fn encode_path(p: &str) -> String {
    let mut out = String::with_capacity(p.len() + 8);
    for b in p.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[tauri::command]
pub fn ensure_server(app: AppHandle, vscode: State<Vscode>) {
    {
        let running = vscode.running.lock().unwrap();
        if let Some(r) = running.as_ref() {
            if health_ok(r.port) {
                return;
            }
        }
    }
    {
        let mut booting = vscode.booting.lock().unwrap();
        if *booting {
            return;
        }
        *booting = true;
    }

    thread::spawn(move || {
        let vscode = app.state::<Vscode>();
        let finish = |ok: bool| {
            *vscode.booting.lock().unwrap() = false;
            let _ = ok;
        };

        let Some(cli) = vscode_cli() else {
            vscode.set_status(
                &app,
                "error",
                "Could not find Visual Studio Code. Install it from code.visualstudio.com.",
                None,
            );
            return finish(false);
        };

        let port = free_port();
        let data_dir = server_data_dir(&app);
        seed_settings(&data_dir);

        vscode.set_status(
            &app,
            "starting",
            "Starting the VS Code server… (the first run downloads it, ~150 MB)",
            None,
        );

        let mut cmd = Command::new(&cli);
        cmd.args([
            "serve-web",
            "--port",
            &port.to_string(),
            "--without-connection-token",
            "--accept-server-license-terms",
            "--disable-telemetry",
            "--server-data-dir",
        ])
        .arg(&data_dir)
        .env("VSCODE_CLI_DATA_DIR", data_dir.join("cli"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                vscode.set_status(&app, "error", &format!("Failed to start VS Code: {e}"), None);
                return finish(false);
            }
        };

        // Drain child output to the app log (helps diagnose first-run downloads).
        if let Some(out) = child.stdout.take() {
            thread::spawn(move || {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    println!("[serve-web] {line}");
                }
            });
        }
        if let Some(err) = child.stderr.take() {
            thread::spawn(move || {
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    eprintln!("[serve-web] {line}");
                }
            });
        }

        {
            *vscode.running.lock().unwrap() = Some(Running { child, port });
        }

        // Wait for the server to answer. First run can take a while.
        let deadline = Instant::now() + Duration::from_secs(240);
        loop {
            if health_ok(port) {
                if !claude_extension_installed(&data_dir) {
                    vscode.set_status(
                        &app,
                        "starting",
                        "Installing the Claude Code extension…",
                        None,
                    );
                    if let Err(e) = install_claude_extension(&data_dir) {
                        vscode.set_status(
                            &app,
                            "error",
                            &format!("Could not install the Claude Code extension: {e}"),
                            None,
                        );
                        return finish(false);
                    }
                }
                write_helper_extension(&data_dir);
                vscode.set_status(&app, "ready", "Ready", Some(port));
                return finish(true);
            }
            if Instant::now() > deadline {
                vscode.set_status(
                    &app,
                    "error",
                    "VS Code server did not come up in time. Check your connection and try again.",
                    None,
                );
                return finish(false);
            }
            // Bail early if the process died.
            if let Some(r) = vscode.running.lock().unwrap().as_mut() {
                if matches!(r.child.try_wait(), Ok(Some(_))) {
                    vscode.set_status(&app, "error", "VS Code server exited unexpectedly.", None);
                    return finish(false);
                }
            }
            thread::sleep(Duration::from_millis(700));
        }
    });
}

#[tauri::command]
pub fn stop_server(vscode: State<Vscode>) {
    for (_, v) in vscode.views.lock().unwrap().drain() {
        let _ = v.close();
    }
    *vscode.visible.lock().unwrap() = None;
    if let Some(mut r) = vscode.running.lock().unwrap().take() {
        let _ = r.child.kill();
    }
}

fn webview_label(path: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in path.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("vscode-{h:x}")
}

/// Show the embedded VS Code for `path` at the given logical rect (CSS pixels
/// from the main webview). Creates the child webview on first use, otherwise
/// repositions and reveals it, hiding whichever project was shown before.
#[tauri::command]
pub fn mount_vscode(
    app: AppHandle,
    vscode: State<Vscode>,
    path: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let port = vscode
        .status
        .lock()
        .unwrap()
        .port
        .ok_or("VS Code server is not ready")?;
    let url = format!("http://127.0.0.1:{port}/?folder={}", encode_path(&path));

    let container = app.get_window("main").ok_or("no main window")?;

    let pos = LogicalPosition::new(x, y);
    let size = LogicalSize::new(w.max(1.0), h.max(1.0));

    let mut views = vscode.views.lock().unwrap();

    {
        let mut visible = vscode.visible.lock().unwrap();
        if let Some(prev) = visible.as_ref() {
            if prev != &path {
                if let Some(v) = views.get(prev) {
                    let _ = v.hide();
                }
            }
        }
        *visible = Some(path.clone());
    }

    match views.get(&path) {
        Some(v) => {
            let _ = v.set_position(pos);
            let _ = v.set_size(size);
            let _ = v.show();
            let _ = v.set_focus();
        }
        None => {
            let builder = WebviewBuilder::new(
                webview_label(&path),
                WebviewUrl::External(url.parse().map_err(|_| "invalid server url".to_string())?),
            );
            let view = container
                .add_child(builder, pos, size)
                .map_err(|e| e.to_string())?;
            views.insert(path, view);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn set_vscode_bounds(vscode: State<Vscode>, x: f64, y: f64, w: f64, h: f64) {
    let views = vscode.views.lock().unwrap();
    if let Some(p) = vscode.visible.lock().unwrap().as_ref() {
        if let Some(v) = views.get(p) {
            let _ = v.set_position(LogicalPosition::new(x, y));
            let _ = v.set_size(LogicalSize::new(w.max(1.0), h.max(1.0)));
        }
    }
}

#[tauri::command]
pub fn hide_vscode(vscode: State<Vscode>) {
    let views = vscode.views.lock().unwrap();
    if let Some(p) = vscode.visible.lock().unwrap().take() {
        if let Some(v) = views.get(&p) {
            let _ = v.hide();
        }
    }
}

fn nonce() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn push_command(data_dir: &PathBuf, payload: serde_json::Value) -> Result<(), String> {
    std::fs::write(
        data_dir.join(COMMAND_FILE),
        serde_json::to_string(&payload).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// Ask the embedded helper extension to do something (start a new chat, open a
/// past session). The helper polls this file, so no extra IPC surface is needed.
#[tauri::command]
pub fn send_vscode_command(
    app: AppHandle,
    command: String,
    session_id: Option<String>,
) -> Result<(), String> {
    push_command(
        &server_data_dir(&app),
        serde_json::json!({
            "nonce": nonce(),
            "command": command,
            "sessionId": session_id,
        }),
    )
}

/// Switch the embedded VS Code between the Claude Code surface and a normal
/// editor. The mode is written to disk as well as pushed, so windows opened
/// later come up in the same mode.
#[tauri::command]
pub fn set_vscode_mode(app: AppHandle, mode: String) -> Result<String, String> {
    let mode = if mode == "code" { "code" } else { "claude" };
    let data_dir = server_data_dir(&app);
    std::fs::write(
        data_dir.join(MODE_FILE),
        serde_json::to_string(&serde_json::json!({ "mode": mode })).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    push_command(
        &data_dir,
        serde_json::json!({ "nonce": nonce(), "command": "setMode", "mode": mode }),
    )?;
    Ok(mode.to_string())
}

#[tauri::command]
pub fn get_vscode_mode(app: AppHandle) -> String {
    std::fs::read_to_string(server_data_dir(&app).join(MODE_FILE))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("mode").and_then(|m| m.as_str()).map(String::from))
        .filter(|m| m == "code")
        .unwrap_or_else(|| "claude".to_string())
}

#[tauri::command]
pub fn close_vscode(vscode: State<Vscode>, path: String) {
    if let Some(v) = vscode.views.lock().unwrap().remove(&path) {
        let _ = v.close();
    }
    let mut visible = vscode.visible.lock().unwrap();
    if visible.as_deref() == Some(path.as_str()) {
        *visible = None;
    }
}

/// Strip VS Code down to a bare editor area — the app shows Claude Code, not an IDE.
const SETTINGS_JSON: &str = r#"{
  "window.customTitleBarVisibility": "never",
  "window.commandCenter": false,
  "window.menuBarVisibility": "hidden",
  "workbench.activityBar.location": "hidden",
  "workbench.statusBar.visible": false,
  "workbench.editor.showTabs": "none",
  "workbench.editor.editorActionsLocation": "hidden",
  "workbench.editor.empty.hint": "hidden",
  "workbench.startupEditor": "none",
  "workbench.layoutControl.enabled": false,
  "workbench.tips.enabled": false,
  "workbench.colorTheme": "Default Dark Modern",
  "breadcrumbs.enabled": false,
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "extensions.autoCheckUpdates": false,
  "security.workspace.trust.enabled": false
}
"#;

const HELPER_PACKAGE_JSON: &str = r#"{
  "name": "easy-switch-layout",
  "displayName": "Easy Switch Layout",
  "description": "Opens Claude Code as the only surface in the window.",
  "publisher": "easyswitch",
  "version": "1.0.6",
  "engines": { "vscode": "^1.94.0" },
  "main": "./extension.js",
  "activationEvents": ["onStartupFinished"],
  "extensionKind": ["workspace"],
  "capabilities": {
    "untrustedWorkspaces": { "supported": true },
    "virtualWorkspaces": true
  },
  "contributes": {}
}
"#;

const HELPER_EXTENSION_JS: &str = r#"const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

// Easy Switch drops commands here; <server-data-dir>/easy-switch-cmd.json sits
// two levels above this extension folder.
const COMMAND_FILE = path.resolve(__dirname, "..", "..", "easy-switch-cmd.json");
const MODE_FILE = path.resolve(__dirname, "..", "..", "easy-switch-mode.json");
const LOG_FILE = path.resolve(__dirname, "..", "..", "easy-switch-helper.log");

function log(msg) {
  try {
    // Keep the diagnostic log from growing without bound.
    try {
      if (fs.statSync(LOG_FILE).size > 64 * 1024) fs.unlinkSync(LOG_FILE);
    } catch (_) {}
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch (_) {}
}

// VS Code for the Web keeps user settings in browser storage, not in the
// server's user-data-dir, so the layout has to be applied through the API.
// The app's own window chrome replaces VS Code's, in both modes.
const BASE = {
  "security.workspace.trust.enabled": false,
  "window.customTitleBarVisibility": "never",
  "window.commandCenter": false,
  "window.menuBarVisibility": "hidden",
  "workbench.startupEditor": "none",
  "workbench.layoutControl.enabled": false,
  "workbench.tips.enabled": false,
  "workbench.colorTheme": "Default Dark Modern",
  "chat.commandCenter.enabled": false,
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "extensions.autoCheckUpdates": false,
  "extensions.ignoreRecommendations": true,
};

// Claude Code owns the whole surface.
const CLAUDE_LAYOUT = {
  "workbench.activityBar.location": "hidden",
  "workbench.statusBar.visible": false,
  "workbench.editor.showTabs": "none",
  "workbench.editor.editorActionsLocation": "hidden",
  "workbench.editor.empty.hint": "hidden",
  "breadcrumbs.enabled": false,
};

// A normal editor: explorer, tabs, status bar.
const CODE_LAYOUT = {
  "workbench.activityBar.location": "default",
  "workbench.statusBar.visible": true,
  "workbench.editor.showTabs": "multiple",
  "workbench.editor.editorActionsLocation": "default",
  "workbench.editor.empty.hint": "text",
  "breadcrumbs.enabled": true,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(cmd) {
  try {
    await vscode.commands.executeCommand(cmd);
    return true;
  } catch (_) {
    return false;
  }
}

function readMode() {
  try {
    const raw = JSON.parse(fs.readFileSync(MODE_FILE, "utf8"));
    return raw && raw.mode === "code" ? "code" : "claude";
  } catch (_) {
    return "claude";
  }
}

async function applySettings(map) {
  const cfg = vscode.workspace.getConfiguration();
  let changed = false;
  for (const key of Object.keys(map)) {
    const want = map[key];
    let current;
    try {
      current = cfg.inspect(key);
    } catch (_) {
      current = undefined;
    }
    if (current && current.globalValue === want) continue;
    try {
      await cfg.update(key, want, vscode.ConfigurationTarget.Global);
      changed = true;
    } catch (_) {}
  }
  return changed;
}

async function applyLayoutSettings() {
  return applySettings(BASE);
}

async function applyMode(mode) {
  const changed = await applySettings(mode === "code" ? CODE_LAYOUT : CLAUDE_LAYOUT);
  log(`applyMode ${mode} changed=${changed}`);
  if (mode === "code") {
    // Bring the file tree back; keep the secondary bar (Copilot chat) out of it.
    await run("workbench.action.closeAuxiliaryBar");
    await run("workbench.action.closePanel");
    await run("workbench.view.explorer");
  } else {
    await collapseChrome();
    await openClaude();
    await sleep(300);
    await collapseChrome();
  }
}

function claudeTabOpen() {
  try {
    return vscode.window.tabGroups.all.some((g) =>
      g.tabs.some((t) => String(t.label || "").toLowerCase().includes("claude")),
    );
  } catch (_) {
    return false;
  }
}

async function collapseChrome() {
  await run("workbench.action.closeSidebar");
  await run("workbench.action.closeAuxiliaryBar");
  await run("workbench.action.closePanel");
}

async function claudeReady() {
  const cmds = await vscode.commands.getCommands(true);
  return cmds.includes("claude-vscode.primaryEditor.open");
}

async function openClaude() {
  for (let i = 0; i < 60; i++) {
    if (claudeTabOpen()) return true;
    if (await claudeReady()) {
      await run("workbench.action.closeAllEditors");
      await run("claude-vscode.primaryEditor.open");
      await sleep(600);
      if (claudeTabOpen()) return true;
    }
    await sleep(500);
  }
  return false;
}

// `claude-vscode.primaryEditor.open(sessionId, prompt)` resumes an existing
// session, or starts a fresh one when no id is given. One chat at a time keeps
// it consistent with the app's own project switcher.
async function openSession(sessionId) {
  if (!(await claudeReady())) return;
  await run("workbench.action.closeAllEditors");
  try {
    await vscode.commands.executeCommand(
      "claude-vscode.primaryEditor.open",
      sessionId || undefined,
    );
  } catch (_) {}
  await sleep(400);
  await collapseChrome();
}

async function handleCommand(msg) {
  if (msg.command === "newChat" || msg.command === "openSession") {
    await applyMode("claude");
    await openSession(msg.sessionId);
  } else if (msg.command === "setMode") {
    await applyMode(msg.mode === "code" ? "code" : "claude");
  }
}

function watchCommands(context) {
  let lastNonce = null;
  const tick = () => {
    let msg;
    try {
      msg = JSON.parse(fs.readFileSync(COMMAND_FILE, "utf8"));
    } catch (_) {
      return;
    }
    if (!msg || msg.nonce === lastNonce) return;
    // Skip whatever was already in the file when this window opened.
    const first = lastNonce === null;
    lastNonce = msg.nonce;
    if (first) return;
    log(`command ${msg.command} mode=${msg.mode || "-"}`);
    handleCommand(msg).catch((e) => log(`command failed: ${e}`));
  };
  tick();
  const timer = setInterval(tick, 400);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

async function activate(context) {
  const changed = await applyLayoutSettings();

  // Turning workspace trust off only takes hold after a reload. Do that at most
  // once so a restricted window cannot loop.
  const RELOAD_KEY = "easySwitch.trustReload.v1";
  if (changed && !vscode.workspace.isTrusted && !context.globalState.get(RELOAD_KEY)) {
    await context.globalState.update(RELOAD_KEY, true);
    await run("workbench.action.reloadWindow");
    return;
  }

  watchCommands(context);

  const mode = readMode();
  log(`activate mode=${mode} trusted=${vscode.workspace.isTrusted}`);
  await applyMode(mode);
}

module.exports = { activate, deactivate() {} };
"#;

fn seed_settings(data_dir: &PathBuf) {
    let user_dir = data_dir.join("data").join("User");
    if std::fs::create_dir_all(&user_dir).is_err() {
        return;
    }
    // The app owns this data dir, so keep the layout settings authoritative.
    let _ = std::fs::write(user_dir.join("settings.json"), SETTINGS_JSON);
}

fn extensions_dir(data_dir: &PathBuf) -> PathBuf {
    data_dir.join("extensions")
}

/// The VS Code server binary that `serve-web` downloads on first run.
fn downloaded_server_bin(data_dir: &PathBuf) -> Option<PathBuf> {
    let root = data_dir.join("cli").join("serve-web");
    let entries = std::fs::read_dir(root).ok()?;
    for e in entries.flatten() {
        let candidate = e.path().join("bin").join("code-server");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn claude_extension_installed(data_dir: &PathBuf) -> bool {
    let Ok(entries) = std::fs::read_dir(extensions_dir(data_dir)) else {
        return false;
    };
    entries.flatten().any(|e| {
        e.file_name()
            .to_string_lossy()
            .starts_with("anthropic.claude-code-")
    })
}

fn install_claude_extension(data_dir: &PathBuf) -> Result<(), String> {
    let bin = downloaded_server_bin(data_dir)
        .ok_or_else(|| "VS Code server binary not found yet".to_string())?;
    let out = Command::new(bin)
        .arg("--install-extension")
        .arg("anthropic.claude-code")
        .arg("--extensions-dir")
        .arg(extensions_dir(data_dir))
        .arg("--server-data-dir")
        .arg(data_dir)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

const COMMAND_FILE: &str = "easy-switch-cmd.json";
const MODE_FILE: &str = "easy-switch-mode.json";
const HELPER_ID: &str = "easyswitch.easy-switch-layout";
const HELPER_FOLDER: &str = "easyswitch.easy-switch-layout-1.0.6";
const HELPER_VERSION: &str = "1.0.6";

/// Drop in a tiny workspace extension that hides the IDE chrome and opens
/// Claude Code in the editor area on every window.
///
/// The server treats `extensions.json` as the list of installed extensions and
/// ignores (in fact, "removes") any folder that is not listed, so the folder has
/// to be registered there too.
fn write_helper_extension(data_dir: &PathBuf) {
    let ext_root = extensions_dir(data_dir);

    // Drop any older copy so the server does not keep stale versions around.
    if let Ok(entries) = std::fs::read_dir(&ext_root) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with("easyswitch.easy-switch-layout-") && name != HELPER_FOLDER {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }

    let dir = ext_root.join(HELPER_FOLDER);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let _ = std::fs::write(dir.join("package.json"), HELPER_PACKAGE_JSON);
    let _ = std::fs::write(dir.join("extension.js"), HELPER_EXTENSION_JS);

    let manifest_path = ext_root.join("extensions.json");
    let mut entries: Vec<serde_json::Value> = match std::fs::read_to_string(&manifest_path) {
        // A manifest we cannot parse is not ours to rewrite — replacing it would
        // drop every other installed extension.
        Ok(text) => match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => return,
        },
        Err(_) => Vec::new(),
    };
    entries.retain(|e| e.pointer("/identifier/id").and_then(|v| v.as_str()) != Some(HELPER_ID));

    // Never publish a manifest that forgets the Claude Code extension.
    if claude_extension_installed(data_dir)
        && !entries.iter().any(|e| {
            e.pointer("/identifier/id").and_then(|v| v.as_str()) == Some("anthropic.claude-code")
        })
    {
        return;
    }

    let fs_path = dir.to_string_lossy().to_string();
    entries.push(serde_json::json!({
        "identifier": { "id": HELPER_ID },
        "version": HELPER_VERSION,
        "location": {
            "$mid": 1,
            "fsPath": fs_path,
            "external": format!("file://{}", encode_path(&fs_path)),
            "path": fs_path,
            "scheme": "file"
        },
        "relativeLocation": HELPER_FOLDER,
        "metadata": {
            "installedTimestamp": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            "source": "vsix",
            "updated": false,
            "private": false,
            "isPreReleaseVersion": false,
            "hasPreReleaseVersion": false
        }
    }));

    // Write through a temp file: the VS Code server reads this manifest and a
    // torn write loses extensions.
    if let Ok(text) = serde_json::to_string(&entries) {
        let tmp = ext_root.join("extensions.json.easy-switch.tmp");
        if std::fs::write(&tmp, text).is_ok() && std::fs::rename(&tmp, &manifest_path).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
}
