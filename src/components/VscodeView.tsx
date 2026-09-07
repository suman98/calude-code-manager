import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Project, type ServerStatus } from "../lib/api";
import { parentPath } from "../lib/format";

interface Props {
  project: Project | null;
  status: ServerStatus;
  dialogOpen: boolean;
  onRetry: () => void;
}

export function VscodeView({ project, status, dialogOpen, onRetry }: Props) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  const [mountErr, setMountErr] = useState<string | null>(null);

  const activeId = project?.path ?? null;
  const ready = status.phase === "ready";
  const shouldShow = ready && !!activeId && !dialogOpen;

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
      {project ? (
        <header className="pane-head" data-tauri-drag-region>
          <div className="pane-title" data-tauri-drag-region>
            <span className="pane-name">{project.name}</span>
            <span className="pane-path">{parentPath(project.path)}</span>
          </div>
          <div className="pane-actions">
            <button className="mini-btn" onClick={() => api.reveal(project.path)}>
              Reveal
            </button>
          </div>
        </header>
      ) : (
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
