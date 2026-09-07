import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Project, type ServerStatus, type VscodeMode } from "../lib/api";
import { parentPath } from "../lib/format";
import { PanelLeftIcon, PanelChatsIcon } from "./icons";

interface Props {
  project: Project | null;
  status: ServerStatus;
  /** hide the native webview while a dialog is up or a pane is being dragged */
  suppressed: boolean;
  firstPane: boolean;
  showProjects: boolean;
  showChats: boolean;
  mode: VscodeMode;
  onMode: (mode: VscodeMode) => void;
  onToggleProjects: () => void;
  onToggleChats: () => void;
  onRetry: () => void;
}

export function VscodeView({
  project,
  status,
  suppressed,
  firstPane,
  showProjects,
  showChats,
  mode,
  onMode,
  onToggleProjects,
  onToggleChats,
  onRetry,
}: Props) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  const [mountErr, setMountErr] = useState<string | null>(null);

  const activeId = project?.path ?? null;
  const ready = status.phase === "ready";
  const shouldShow = ready && !!activeId && !suppressed;

  const pushBounds = useCallback(
    (mount: boolean) => {
      const el = slotRef.current;
      if (!el || !activeId) return;
      const r = el.getBoundingClientRect();
      const rect = { x: r.left, y: r.top, w: r.width, h: r.height };
      if (mount) {
        api
          .mountVscode(activeId, rect)
          .then(() => setMountErr(null))
          .catch((e) => setMountErr(String(e)));
      } else {
        api.setVscodeBounds(rect).catch(() => {});
      }
    },
    [activeId],
  );

  useEffect(() => {
    if (!shouldShow) {
      api.hideVscode().catch(() => {});
      return;
    }
    const raf = requestAnimationFrame(() => pushBounds(true));
    return () => cancelAnimationFrame(raf);
  }, [shouldShow, activeId, pushBounds]);

  useEffect(() => {
    if (!shouldShow) return;
    const el = slotRef.current;
    if (!el) return;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => pushBounds(false));
    };
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      cancelAnimationFrame(raf);
    };
  }, [shouldShow, pushBounds]);

  if (!ready) {
    return (
      <div className="boot">
        <div className={"boot-spinner" + (status.phase === "error" ? " err" : "")} />
        <h2>{status.phase === "error" ? "VS Code server problem" : "Preparing Claude Code"}</h2>
        <p>{status.message || "Starting…"}</p>
        {status.phase === "error" ? (
          <button className="primary-btn" onClick={onRetry}>
            Try again
          </button>
        ) : (
          <p className="boot-note">
            The first launch downloads the VS Code server (~150&nbsp;MB). Later starts are quick.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="pane">
      <header
        className={"pane-top pane-head" + (firstPane ? " with-traffic" : "")}
        data-tauri-drag-region
      >
        <div className="pane-toggles">
          <button
            className={"toggle-btn" + (showProjects ? " on" : "")}
            onClick={onToggleProjects}
            title="Toggle projects (⌘1)"
            aria-pressed={showProjects}
          >
            <PanelLeftIcon />
          </button>
          <button
            className={"toggle-btn" + (showChats ? " on" : "")}
            onClick={onToggleChats}
            title="Toggle chat history (⌘2)"
            aria-pressed={showChats}
          >
            <PanelChatsIcon />
          </button>
        </div>

        {project && (
          <div className="pane-title" data-tauri-drag-region>
            <span className="pane-name">{project.name}</span>
            <span className="pane-path">{parentPath(project.path)}</span>
          </div>
        )}

        <div className="pane-actions">
          {project && (
            <div className="mode-switch" role="group" aria-label="Editor mode">
              <button
                className={mode === "claude" ? "on" : ""}
                onClick={() => onMode("claude")}
                aria-pressed={mode === "claude"}
                title="Claude Code only (⌘E)"
              >
                Claude
              </button>
              <button
                className={mode === "code" ? "on" : ""}
                onClick={() => onMode("code")}
                aria-pressed={mode === "code"}
                title="Source code — explorer, tabs, status bar (⌘E)"
              >
                Code
              </button>
            </div>
          )}
          {project && (
            <button className="mini-btn" onClick={() => api.reveal(project.path)}>
              Reveal
            </button>
          )}
        </div>
      </header>

      {!project && (
        <div className="pane-empty">
          <div className="pane-empty-glyph">◐</div>
          <p>Pick a project on the left to open it here with Claude Code.</p>
        </div>
      )}

      {project && mountErr && (
        <div className="notice error inline">Could not embed VS Code: {mountErr}</div>
      )}
      {project && <div className="vscode-slot" ref={slotRef} />}
    </div>
  );
}
