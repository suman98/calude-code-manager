import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

export interface Project {
  path: string;
  name: string;
  favorite: boolean;
  last_opened: number | null;
  added: number;
  open_count: number;
}

export interface Discovered {
  path: string;
  name: string;
  already_added: boolean;
  modified: number;
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
