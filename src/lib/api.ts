import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

export interface Project {
  path: string;
  name: string;
  favorite: boolean;
  last_opened: number | null;
  added: number;
  open_count: number;
  color: string | null;
  icon: string | null;
}

export interface Discovered {
  path: string;
  name: string;
  already_added: boolean;
  modified: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  last_prompt: string;
  started: string | null;
  updated: string | null;
  git_branch: string | null;
  models: string[];
  messages: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface Totals {
  sessions: number;
  messages: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface ModelUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  messages: number;
}

export interface ProjectUsage {
  path: string;
  name: string;
  totals: Totals;
  last_used: string | null;
}

export interface UsageOverview {
  totals: Totals;
  projects: ProjectUsage[];
  by_model: ModelUsage[];
}

export interface WindowUsage {
  tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  messages: number;
  window_start: number | null;
  resets_at: number | null;
  limit: number | null;
}

export interface UsageWindows {
  session: WindowUsage;
  weekly: WindowUsage;
  now: number;
}

export type VscodeMode = "claude" | "code";

/** Server-reported utilisation, the same figures Claude Code's /usage prints. */
export interface LiveWindow {
  utilization: number;
  resets_at: number | null;
}

export interface LiveUsage {
  five_hour: LiveWindow | null;
  seven_day: LiveWindow | null;
  seven_day_opus: LiveWindow | null;
  fetched_at: number;
}

export interface Limits {
  session_tokens: number | null;
  weekly_tokens: number | null;
}

export interface ServerStatus {
  phase: "idle" | "starting" | "ready" | "error";
  message: string;
  port: number | null;
}

export const api = {
  list: () => invoke<Project[]>("list_projects"),
  add: (path: string) => invoke<Project[]>("add_project", { path }),
  addMany: (paths: string[]) => invoke<Project[]>("add_projects", { paths }),
  remove: (path: string) => invoke<Project[]>("remove_project", { path }),
  toggleFavorite: (path: string) => invoke<Project[]>("toggle_favorite", { path }),
  reorder: (order: string[]) => invoke<Project[]>("reorder_projects", { order }),
  setColor: (path: string, color: string | null) =>
    invoke<Project[]>("set_project_color", { path, color }),
  setIcon: (path: string, source: string) =>
    invoke<Project[]>("set_project_icon", { path, source }),
  clearIcon: (path: string) => invoke<Project[]>("clear_project_icon", { path }),
  touch: (path: string) => invoke<Project[]>("touch_project", { path }),
  reveal: (path: string) => invoke<void>("reveal_in_file_manager", { path }),
  discover: () => invoke<Discovered[]>("discover_vscode_projects"),

  // embedded VS Code server
  ensureServer: () => invoke<void>("ensure_server"),
  serverStatus: () => invoke<ServerStatus>("server_status"),
  folderUrl: (path: string) => invoke<string>("folder_url", { path }),

  // embedded VS Code child webview
  mountVscode: (path: string, b: Rect) => invoke<void>("mount_vscode", { path, ...b }),
  setVscodeBounds: (b: Rect) => invoke<void>("set_vscode_bounds", { ...b }),
  hideVscode: () => invoke<void>("hide_vscode"),
  closeVscode: (path: string) => invoke<void>("close_vscode", { path }),

  // chats + usage, read from Claude Code's own transcript store
  listSessions: (path: string) => invoke<SessionSummary[]>("list_sessions", { path }),
  projectUsage: (path: string) => invoke<Totals>("project_usage", { path }),
  usageOverview: () => invoke<UsageOverview>("usage_overview"),
  claudeUsage: () => invoke<LiveUsage>("claude_usage"),
  usageWindows: (limits: Limits) =>
    invoke<UsageWindows>("usage_windows", {
      sessionLimit: limits.session_tokens,
      weeklyLimit: limits.weekly_tokens,
    }),
  getLimits: () => invoke<Limits>("get_limits"),
  setLimits: (limits: Limits) =>
    invoke<Limits>("set_limits", {
      sessionTokens: limits.session_tokens,
      weeklyTokens: limits.weekly_tokens,
    }),
  newChat: () => invoke<void>("send_vscode_command", { command: "newChat", sessionId: null }),
  setMode: (mode: VscodeMode) => invoke<VscodeMode>("set_vscode_mode", { mode }),
  getMode: () => invoke<VscodeMode>("get_vscode_mode"),
  openSession: (sessionId: string) =>
    invoke<void>("send_vscode_command", { command: "openSession", sessionId }),
};

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export async function pickFolder(): Promise<string | null> {
  const result = await openDialog({ directory: true, multiple: false, title: "Add a project folder" });
  return typeof result === "string" ? result : null;
}

export async function pickImage(): Promise<string | null> {
  const result = await openDialog({
    directory: false,
    multiple: false,
    title: "Choose a project icon",
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
  });
  return typeof result === "string" ? result : null;
}
