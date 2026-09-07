// Reads Claude Code's own transcript store (`~/.claude/projects/<slug>/<id>.jsonl`)
// to list past chats per project and roll up token usage.
//
// The directory slug is a lossy encoding of the project path, so instead of
// trying to reverse it we read the `cwd` recorded inside each transcript.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

#[derive(Serialize, Clone, Default, Debug)]
pub struct Totals {
    pub sessions: u32,
    pub messages: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

impl Totals {
    fn absorb(&mut self, other: &Totals) {
        self.sessions += other.sessions;
        self.messages += other.messages;
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_read_tokens += other.cache_read_tokens;
        self.cache_write_tokens += other.cache_write_tokens;
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub last_prompt: String,
    /// ISO-8601 UTC, directly parseable by `Date.parse` on the frontend.
    pub started: Option<String>,
    pub updated: Option<String>,
    pub git_branch: Option<String>,
    pub models: Vec<String>,
    pub messages: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct ProjectUsage {
    pub path: String,
    pub name: String,
    pub totals: Totals,
    pub last_used: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct UsageOverview {
    pub totals: Totals,
    pub projects: Vec<ProjectUsage>,
    pub by_model: Vec<ModelUsage>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ModelUsage {
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub messages: u64,
}

/// Per-file parse cache, invalidated on (mtime, size).
#[derive(Default)]
struct Cache {
    files: HashMap<PathBuf, (u64, u64, Parsed)>,
    dir_cwd: HashMap<PathBuf, Option<String>>,
}

#[derive(Default)]
pub struct Sessions(Mutex<Cache>);

/// One billed assistant turn, kept so usage can be sliced by time window.
#[derive(Clone, Copy, Debug)]
struct Event {
    at: i64,
    input: u32,
    output: u32,
    cache_read: u32,
    cache_write: u32,
}

#[derive(Clone, Debug, Default)]
struct Parsed {
    summary: Option<SessionSummary>,
    /// per-model token counts inside this transcript
    per_model: Vec<ModelUsage>,
    events: Vec<Event>,
    #[allow(dead_code)]
    cwd: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct WindowUsage {
    /// input + output + cache writes; cache reads are reported separately
    pub tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub messages: u64,
    /// epoch ms of the first turn in the window
    pub window_start: Option<i64>,
    /// epoch ms when this window rolls over
    pub resets_at: Option<i64>,
    pub limit: Option<u64>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct UsageWindows {
    pub session: WindowUsage,
    pub weekly: WindowUsage,
    pub now: i64,
}

const FIVE_HOURS_MS: i64 = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS: i64 = 7 * 24 * 60 * 60 * 1000;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
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
    era * 146097 + doe - 719468
}

/// Parses the fixed `YYYY-MM-DDTHH:MM:SS(.sss)Z` shape Claude Code writes.
fn iso_to_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let num = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let millis = if b.len() >= 23 && b[19] == b'.' {
        num(20, 23).unwrap_or(0)
    } else {
        0
    };
    Some(((days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + sec) * 1000) + millis)
}

fn claude_projects_root() -> Option<PathBuf> {
    let dir = dirs::home_dir()?.join(".claude").join("projects");
    dir.is_dir().then_some(dir)
}

fn file_stamp(p: &Path) -> (u64, u64) {
    match fs::metadata(p) {
        Ok(m) => {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            (mtime, m.len())
        }
        Err(_) => (0, 0),
    }
}

fn text_of(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(items) => items
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

fn truncate(s: &str, max: usize) -> String {
    let clean = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() <= max {
        return clean;
    }
    let cut: String = clean.chars().take(max).collect();
    format!("{}…", cut.trim_end())
}

fn parse_transcript(path: &Path) -> Parsed {
    let Ok(file) = fs::File::open(path) else {
        return Parsed::default();
    };
    let id = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut ai_title: Option<String> = None;
    let mut last_prompt: Option<String> = None;
    let mut first_user: Option<String> = None;
    let mut started: Option<String> = None;
    let mut updated: Option<String> = None;
    let mut git_branch: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut messages: u64 = 0;
    let mut models: Vec<String> = Vec::new();
    let mut per_model: HashMap<String, ModelUsage> = HashMap::new();
    let mut events: Vec<Event> = Vec::new();
    let (mut input, mut output, mut cread, mut cwrite) = (0u64, 0u64, 0u64, 0u64);

    // Transcripts can be large; stream them with a generous line cap.
    let reader = BufReader::with_capacity(1 << 16, file);
    for line in reader.lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");

        if cwd.is_none() {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                cwd = Some(c.trim_end_matches('/').to_string());
            }
        }
        if git_branch.is_none() {
            if let Some(b) = v.get("gitBranch").and_then(|b| b.as_str()) {
                if !b.is_empty() {
                    git_branch = Some(b.to_string());
                }
            }
        }
        if let Some(ts) = v.get("timestamp").and_then(|t| t.as_str()) {
            if started.is_none() {
                started = Some(ts.to_string());
            }
            updated = Some(ts.to_string());
        }

        match kind {
            "ai-title" => {
                if let Some(t) = v.get("aiTitle").and_then(|t| t.as_str()) {
                    ai_title = Some(t.to_string());
                }
            }
            "last-prompt" => {
                if let Some(t) = v.get("lastPrompt").and_then(|t| t.as_str()) {
                    last_prompt = Some(t.to_string());
                }
            }
            "user" => {
                messages += 1;
                if first_user.is_none() {
                    if let Some(c) = v.pointer("/message/content") {
                        let t = text_of(c);
                        if !t.trim().is_empty() {
                            first_user = Some(t);
                        }
                    }
                }
            }
            "assistant" => {
                messages += 1;
                let model = v
                    .pointer("/message/model")
                    .and_then(|m| m.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                if model != "<synthetic>" && !models.contains(&model) {
                    models.push(model.clone());
                }
                if let Some(u) = v.pointer("/message/usage") {
                    let g = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
                    let (i, o, cr, cw) = (
                        g("input_tokens"),
                        g("output_tokens"),
                        g("cache_read_input_tokens"),
                        g("cache_creation_input_tokens"),
                    );
                    input += i;
                    output += o;
                    cread += cr;
                    cwrite += cw;

                    let entry = per_model.entry(model.clone()).or_insert(ModelUsage {
                        model,
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_read_tokens: 0,
                        cache_write_tokens: 0,
                        messages: 0,
                    });
                    entry.input_tokens += i;
                    entry.output_tokens += o;
                    entry.cache_read_tokens += cr;
                    entry.cache_write_tokens += cw;
                    entry.messages += 1;

                    if let Some(at) = v
                        .get("timestamp")
                        .and_then(|t| t.as_str())
                        .and_then(iso_to_ms)
                    {
                        events.push(Event {
                            at,
                            input: i.min(u32::MAX as u64) as u32,
                            output: o.min(u32::MAX as u64) as u32,
                            cache_read: cr.min(u32::MAX as u64) as u32,
                            cache_write: cw.min(u32::MAX as u64) as u32,
                        });
                    }
                }
            }
            _ => {}
        }
    }

    if messages == 0 && ai_title.is_none() && last_prompt.is_none() {
        // Nothing user-visible in here (e.g. an aborted session).
        return Parsed {
            summary: None,
            per_model: Vec::new(),
            events,
            cwd,
        };
    }

    let title = ai_title
        .or_else(|| first_user.clone())
        .or_else(|| last_prompt.clone())
        .unwrap_or_else(|| "Untitled chat".to_string());

    Parsed {
        summary: Some(SessionSummary {
            id,
            title: truncate(&title, 80),
            last_prompt: truncate(last_prompt.or(first_user).unwrap_or_default().as_str(), 140),
            started,
            updated,
            git_branch,
            models,
            messages,
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: cread,
            cache_write_tokens: cwrite,
        }),
        per_model: per_model.into_values().collect(),
        events,
        cwd,
    }
}

fn transcripts_in(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|e| e == "jsonl").unwrap_or(false))
        .collect()
}

impl Sessions {
    fn parsed(&self, path: &Path) -> Parsed {
        let stamp = file_stamp(path);
        {
            let cache = self.0.lock().unwrap();
            if let Some((m, s, parsed)) = cache.files.get(path) {
                if (*m, *s) == stamp {
                    return parsed.clone();
                }
            }
        }
        let parsed = parse_transcript(path);
        self.0
            .lock()
            .unwrap()
            .files
            .insert(path.to_path_buf(), (stamp.0, stamp.1, parsed.clone()));
        parsed
    }

    /// Project path recorded inside a transcript directory (cached).
    fn dir_cwd(&self, dir: &Path) -> Option<String> {
        if let Some(hit) = self.0.lock().unwrap().dir_cwd.get(dir) {
            return hit.clone();
        }
        let mut found = None;
        for file in transcripts_in(dir) {
            if let Some(c) = first_cwd(&file) {
                found = Some(c);
                break;
            }
        }
        self.0
            .lock()
            .unwrap()
            .dir_cwd
            .insert(dir.to_path_buf(), found.clone());
        found
    }
}

/// Cheap scan: only read until the first record carrying a `cwd`.
fn first_cwd(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines().take(200).map_while(Result::ok) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                return Some(c.trim_end_matches('/').to_string());
            }
        }
    }
    None
}

fn dir_for_project(sessions: &Sessions, project: &str) -> Option<PathBuf> {
    let root = claude_projects_root()?;
    let target = project.trim_end_matches('/');
    for entry in fs::read_dir(root).ok()?.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        if sessions.dir_cwd(&dir).as_deref() == Some(target) {
            return Some(dir);
        }
    }
    None
}

// ── commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_sessions(sessions: State<Sessions>, path: String) -> Vec<SessionSummary> {
    sessions_for(&sessions, &path)
}

pub fn sessions_for(sessions: &Sessions, path: &str) -> Vec<SessionSummary> {
    let Some(dir) = dir_for_project(sessions, path) else {
        return Vec::new();
    };
    let mut out: Vec<SessionSummary> = transcripts_in(&dir)
        .iter()
        .filter_map(|f| sessions.parsed(f).summary)
        .collect();
    // ISO-8601 UTC sorts correctly as plain text.
    out.sort_by(|a, b| b.updated.cmp(&a.updated));
    out
}

#[tauri::command]
pub fn project_usage(sessions: State<Sessions>, path: String) -> Totals {
    let mut totals = Totals::default();
    for s in sessions_for(&sessions, &path) {
        totals.sessions += 1;
        totals.messages += s.messages;
        totals.input_tokens += s.input_tokens;
        totals.output_tokens += s.output_tokens;
        totals.cache_read_tokens += s.cache_read_tokens;
        totals.cache_write_tokens += s.cache_write_tokens;
    }
    totals
}

fn all_events(sessions: &Sessions, since: i64) -> Vec<Event> {
    let mut out: Vec<Event> = Vec::new();
    let Some(root) = claude_projects_root() else {
        return out;
    };
    for entry in fs::read_dir(root).into_iter().flatten().flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        for file in transcripts_in(&dir) {
            // Skip transcripts untouched since the window opened.
            let (mtime, _) = file_stamp(&file);
            if (mtime as i64) * 1000 < since {
                continue;
            }
            out.extend(sessions.parsed(&file).events.into_iter().filter(|e| e.at >= since));
        }
    }
    out.sort_by_key(|e| e.at);
    out
}

fn window_from(events: &[Event], span: i64, now: i64, limit: Option<u64>) -> WindowUsage {
    let start_bound = now - span;
    let mut w = WindowUsage {
        limit,
        ..Default::default()
    };
    for e in events.iter().filter(|e| e.at >= start_bound && e.at <= now) {
        if w.window_start.is_none() {
            w.window_start = Some(e.at);
        }
        w.input_tokens += e.input as u64;
        w.output_tokens += e.output as u64;
        w.cache_read_tokens += e.cache_read as u64;
        w.cache_write_tokens += e.cache_write as u64;
        w.messages += 1;
    }
    w.tokens = w.input_tokens + w.output_tokens + w.cache_write_tokens;
    w.resets_at = w.window_start.map(|s| s + span);
    w
}

/// Rolling 5-hour and 7-day usage, anchored on the first turn inside each
/// window. These are computed from local transcripts — they are not the plan
/// quota figures Anthropic reports, which are not stored on disk.
#[tauri::command]
pub fn usage_windows(
    sessions: State<Sessions>,
    session_limit: Option<u64>,
    weekly_limit: Option<u64>,
) -> UsageWindows {
    let now = now_ms();
    let events = all_events(&sessions, now - SEVEN_DAYS_MS);
    UsageWindows {
        session: window_from(&events, FIVE_HOURS_MS, now, session_limit),
        weekly: window_from(&events, SEVEN_DAYS_MS, now, weekly_limit),
        now,
    }
}

#[tauri::command]
pub fn usage_overview(sessions: State<Sessions>) -> UsageOverview {
    overview_for(&sessions)
}

pub fn overview_for(sessions: &Sessions) -> UsageOverview {
    let mut totals = Totals::default();
    let mut projects: Vec<ProjectUsage> = Vec::new();
    let mut by_model: HashMap<String, ModelUsage> = HashMap::new();

    let Some(root) = claude_projects_root() else {
        return UsageOverview {
            totals,
            projects,
            by_model: Vec::new(),
        };
    };

    for entry in fs::read_dir(root).into_iter().flatten().flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Some(cwd) = sessions.dir_cwd(&dir) else {
            continue;
        };

        let mut project_totals = Totals::default();
        let mut last_used: Option<String> = None;

        for file in transcripts_in(&dir) {
            let parsed = sessions.parsed(&file);
            for m in parsed.per_model {
                let entry = by_model.entry(m.model.clone()).or_insert(ModelUsage {
                    model: m.model.clone(),
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_read_tokens: 0,
                    cache_write_tokens: 0,
                    messages: 0,
                });
                entry.input_tokens += m.input_tokens;
                entry.output_tokens += m.output_tokens;
                entry.cache_read_tokens += m.cache_read_tokens;
                entry.cache_write_tokens += m.cache_write_tokens;
                entry.messages += m.messages;
            }
            let Some(s) = parsed.summary else { continue };
            project_totals.sessions += 1;
            project_totals.messages += s.messages;
            project_totals.input_tokens += s.input_tokens;
            project_totals.output_tokens += s.output_tokens;
            project_totals.cache_read_tokens += s.cache_read_tokens;
            project_totals.cache_write_tokens += s.cache_write_tokens;
            if s.updated > last_used {
                last_used = s.updated;
            }
        }

        if project_totals.sessions == 0 {
            continue;
        }
        totals.absorb(&project_totals);
        projects.push(ProjectUsage {
            name: Path::new(&cwd)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| cwd.clone()),
            path: cwd,
            totals: project_totals,
            last_used,
        });
    }

    projects.sort_by(|a, b| {
        let a_tok = a.totals.input_tokens + a.totals.output_tokens;
        let b_tok = b.totals.input_tokens + b.totals.output_tokens;
        b_tok.cmp(&a_tok)
    });

    let mut by_model: Vec<ModelUsage> = by_model.into_values().collect();
    by_model.sort_by(|a, b| b.output_tokens.cmp(&a.output_tokens));

    UsageOverview {
        totals,
        projects,
        by_model,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exercises the parser against the real transcript store on this machine.
    /// Skips cleanly when there is no `~/.claude/projects`.
    #[test]
    fn reads_local_transcripts() {
        let Some(root) = claude_projects_root() else {
            eprintln!("no ~/.claude/projects — skipping");
            return;
        };
        let sessions = Sessions::default();
        let overview = overview_for(&sessions);

        eprintln!(
            "projects={} sessions={} messages={} in={} out={} cache_r={} cache_w={}",
            overview.projects.len(),
            overview.totals.sessions,
            overview.totals.messages,
            overview.totals.input_tokens,
            overview.totals.output_tokens,
            overview.totals.cache_read_tokens,
            overview.totals.cache_write_tokens
        );
        for m in overview.by_model.iter().take(6) {
            eprintln!("  model {} msgs={} out={}", m.model, m.messages, m.output_tokens);
        }
        for p in overview.projects.iter().take(5) {
            eprintln!(
                "  project {} chats={} msgs={} last={:?}",
                p.name, p.totals.sessions, p.totals.messages, p.last_used
            );
        }

        assert!(root.is_dir());
        assert!(!overview.projects.is_empty(), "expected at least one project");
        assert!(overview.totals.messages > 0, "expected messages");

        // Per-project lookup must resolve through the recorded cwd.
        let first = overview.projects[0].clone();
        let rows = sessions_for(&sessions, &first.path);
        eprintln!("lookup {} -> {} sessions", first.path, rows.len());
        assert_eq!(rows.len() as u32, first.totals.sessions);
        assert!(rows.iter().all(|r| !r.title.is_empty()));
        // Newest first.
        assert!(rows.windows(2).all(|w| w[0].updated >= w[1].updated));
    }

    #[test]
    fn parses_iso_timestamps() {
        // 2026-09-06T15:16:00.494Z
        let ms = iso_to_ms("2026-09-06T15:16:00.494Z").expect("parses");
        assert_eq!(ms, 1788707760494);
        assert_eq!(iso_to_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(iso_to_ms("2024-02-29T12:00:00Z"), Some(1709208000000));
        assert!(iso_to_ms("nonsense").is_none());
    }

    #[test]
    fn rolling_windows_respect_bounds() {
        let now = 1_000_000_000_000i64;
        let hour = 3_600_000i64;
        let ev = |at: i64, out: u32| Event {
            at,
            input: 10,
            output: out,
            cache_read: 100,
            cache_write: 5,
        };
        let events = vec![
            ev(now - 8 * hour, 1),  // outside the 5h window
            ev(now - 3 * hour, 2),  // inside
            ev(now - 1 * hour, 3),  // inside
        ];

        let w = window_from(&events, FIVE_HOURS_MS, now, Some(1000));
        assert_eq!(w.messages, 2);
        assert_eq!(w.output_tokens, 5);
        // tokens = input + output + cache writes, cache reads excluded
        assert_eq!(w.tokens, 10 * 2 + 5 + 5 * 2);
        assert_eq!(w.cache_read_tokens, 200);
        assert_eq!(w.window_start, Some(now - 3 * hour));
        assert_eq!(w.resets_at, Some(now - 3 * hour + FIVE_HOURS_MS));
        assert_eq!(w.limit, Some(1000));

        let wk = window_from(&events, SEVEN_DAYS_MS, now, None);
        assert_eq!(wk.messages, 3);
        assert_eq!(wk.window_start, Some(now - 8 * hour));
    }

    #[test]
    fn usage_windows_runs_on_real_data() {
        if claude_projects_root().is_none() {
            return;
        }
        let sessions = Sessions::default();
        let now = now_ms();
        let events = all_events(&sessions, now - SEVEN_DAYS_MS);
        let s = window_from(&events, FIVE_HOURS_MS, now, None);
        let w = window_from(&events, SEVEN_DAYS_MS, now, None);
        eprintln!(
            "5h: {} msgs, {} tokens, resets_at={:?}",
            s.messages, s.tokens, s.resets_at
        );
        eprintln!(
            "7d: {} msgs, {} tokens, resets_at={:?}",
            w.messages, w.tokens, w.resets_at
        );
        assert!(w.messages >= s.messages);
        assert!(events.windows(2).all(|p| p[0].at <= p[1].at), "sorted");
    }
}
