// Claude account switching.
//
// Claude Code picks its identity from `CLAUDE_CODE_OAUTH_TOKEN` when that is
// set, and otherwise from the keychain login. Claude Manager mirrors that: the
// user registers token-backed accounts, picks one, and the VS Code server is
// respawned with (or without) the variable.
//
// Tokens themselves live in the login keychain under `easy-switch-oauth`, never
// in the project store — the store only remembers labels and which one is on.

use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

pub const KEYCHAIN_SERVICE: &str = "easy-switch-oauth";

/// A registered token. The default login (no env var) is not an entry here —
/// it is what `active` being `None` means.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Account {
    /// stable key, also the keychain account name
    pub id: String,
    pub label: String,
    /// first/last few characters, for confirming which token this is
    #[serde(default)]
    pub hint: String,
}

/// What the UI shows in the header.
#[derive(Serialize, Clone, Debug)]
pub struct AccountState {
    pub accounts: Vec<Account>,
    /// `None` = use the Claude Code keychain login
    pub active: Option<String>,
}

fn masked(token: &str) -> String {
    let n = token.chars().count();
    if n <= 12 {
        return "•".repeat(n.min(8));
    }
    let head: String = token.chars().take(8).collect();
    let tail: String = token.chars().skip(n - 4).collect();
    format!("{head}…{tail}")
}

pub fn store_token(id: &str, token: &str) -> Result<String, String> {
    // -U updates in place when the entry already exists.
    let out = Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            id,
            "-w",
            token,
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("keychain write failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "keychain write failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(masked(token))
}

pub fn read_token(id: &str) -> Option<String> {
    let out = Command::new("security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", id, "-w"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!token.is_empty()).then_some(token)
}

pub fn forget_token(id: &str) {
    let _ = Command::new("security")
        .args(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", id])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Tokens sitting in the user's shell profile, offered as a starting point so
/// they need not be pasted by hand. Values are never returned to the frontend.
pub fn scan_shell_profiles() -> Vec<(String, String)> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let mut found: Vec<(String, String)> = Vec::new();
    for file in [".zshrc", ".bashrc", ".zprofile", ".profile", ".zshenv"] {
        let Ok(text) = std::fs::read_to_string(home.join(file)) else {
            continue;
        };
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with('#') || !line.contains("CLAUDE_CODE_OAUTH_TOKEN") {
                continue;
            }
            let Some((_, rhs)) = line.split_once("CLAUDE_CODE_OAUTH_TOKEN=") else {
                continue;
            };
            let token = rhs
                .trim()
                .trim_matches(|c| c == '"' || c == '\'')
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_string();
            if token.starts_with("sk-ant-") && !found.iter().any(|(_, t)| *t == token) {
                found.push((format!("{file} · {}", masked(&token)), token));
            }
        }
    }
    found
}

pub fn hint_for(token: &str) -> String {
    masked(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_all_but_the_ends() {
        let m = masked("sk-ant-oat01-abcdefghijklmnop");
        assert!(m.starts_with("sk-ant-o"));
        assert!(m.ends_with("mnop"));
        assert!(!m.contains("abcdefghij"));
    }

    #[test]
    fn short_secrets_are_fully_hidden() {
        assert_eq!(masked("abc"), "•••");
    }
}
