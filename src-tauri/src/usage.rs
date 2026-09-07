// Live usage limits, straight from Claude's own source of truth.
//
// Claude Code's `/usage` numbers are server-side utilisation percentages, not
// anything derivable from local transcripts — so we ask the same endpoint it
// does, reusing the OAuth token Claude Code already stored in the macOS
// keychain. Nothing is written back; the token never leaves this process except
// as the Authorization header to api.anthropic.com, which issued it.

use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA: &str = "oauth-2025-04-20";

#[derive(Serialize, Clone, Copy, Debug)]
pub struct LiveWindow {
    /// 0–100, as the server reports it
    pub utilization: f64,
    /// epoch ms when this window rolls over
    pub resets_at: Option<i64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct LiveUsage {
    pub five_hour: Option<LiveWindow>,
    pub seven_day: Option<LiveWindow>,
    /// Opus-specific weekly window; absent on plans that don't meter it
    pub seven_day_opus: Option<LiveWindow>,
    pub fetched_at: i64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Days since the Unix epoch for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// "2026-09-07T09:39:59.534215+00:00" / "…Z" → epoch ms. Sub-second precision
/// is dropped; these are countdown timestamps, not measurements.
fn parse_rfc3339_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let num = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);

    let mut ms = (days_from_civil(y, mo, d) * 86_400 + h * 3_600 + mi * 60 + sec) * 1_000;

    // Trailing zone: Z, or ±HH:MM which we subtract to get UTC.
    let tail = &s[19..];
    if let Some(at) = tail.rfind(['+', '-']) {
        let zone = &tail[at..];
        let sign = if zone.starts_with('-') { -1 } else { 1 };
        let zh: i64 = zone.get(1..3)?.parse().ok()?;
        let zm: i64 = zone.get(4..6).and_then(|v| v.parse().ok()).unwrap_or(0);
        ms -= sign * (zh * 3_600 + zm * 60) * 1_000;
    }
    Some(ms)
}

fn window_from(v: &Value) -> Option<LiveWindow> {
    let w = v.as_object()?;
    let utilization = w.get("utilization")?.as_f64()?;
    let resets_at = w
        .get("resets_at")
        .and_then(|r| r.as_str())
        .and_then(parse_rfc3339_ms);
    Some(LiveWindow {
        utilization,
        resets_at,
    })
}

/// The OAuth access token Claude Code keeps in the login keychain.
fn access_token() -> Result<String, String> {
    let out = Command::new("security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
        .output()
        .map_err(|e| format!("keychain read failed: {e}"))?;
    if !out.status.success() {
        return Err("no Claude Code credentials in the keychain".into());
    }
    let raw = String::from_utf8_lossy(&out.stdout);
    let creds: Value = serde_json::from_str(raw.trim()).map_err(|_| "unreadable credentials")?;
    let oauth = creds
        .get("claudeAiOauth")
        .ok_or("credentials are not an OAuth login")?;

    // expiresAt is epoch ms; a stale token would just 401.
    if let Some(exp) = oauth.get("expiresAt").and_then(|v| v.as_i64()) {
        if exp <= now_ms() {
            return Err("Claude Code login has expired — open Claude Code to refresh it".into());
        }
    }
    oauth
        .get("accessToken")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| "no access token in credentials".into())
}

#[tauri::command]
pub fn claude_usage() -> Result<LiveUsage, String> {
    let token = access_token()?;
    let resp = ureq::get(USAGE_URL)
        .set("Authorization", &format!("Bearer {token}"))
        .set("anthropic-beta", OAUTH_BETA)
        .set("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(10))
        .call();

    let body: Value = match resp {
        Ok(r) => r.into_json().map_err(|e| format!("bad usage payload: {e}"))?,
        Err(ureq::Error::Status(401, _)) => {
            return Err("Claude Code login is no longer valid — sign in again".into())
        }
        Err(ureq::Error::Status(code, _)) => return Err(format!("usage request failed ({code})")),
        Err(e) => return Err(format!("usage request failed: {e}")),
    };

    Ok(LiveUsage {
        five_hour: body.get("five_hour").and_then(window_from),
        seven_day: body.get("seven_day").and_then(window_from),
        seven_day_opus: body.get("seven_day_opus").and_then(window_from),
        fetched_at: now_ms(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_offset_and_zulu_timestamps() {
        // 2026-09-07T09:39:59Z
        let expect = 1_788_773_999_000;
        assert_eq!(parse_rfc3339_ms("2026-09-07T09:39:59.534215+00:00"), Some(expect));
        assert_eq!(parse_rfc3339_ms("2026-09-07T09:39:59Z"), Some(expect));
        // +05:45 is 5h45m ahead, so the same wall clock is earlier in UTC.
        assert_eq!(
            parse_rfc3339_ms("2026-09-07T15:24:59+05:45"),
            Some(expect)
        );
    }

    #[test]
    fn reads_window_shape() {
        let v: Value = serde_json::from_str(
            r#"{"utilization":46.0,"resets_at":"2026-09-12T04:59:59.534245+00:00"}"#,
        )
        .unwrap();
        let w = window_from(&v).unwrap();
        assert_eq!(w.utilization, 46.0);
        assert!(w.resets_at.unwrap() > 0);
    }

    #[test]
    fn null_window_is_none() {
        assert!(window_from(&Value::Null).is_none());
    }
}
