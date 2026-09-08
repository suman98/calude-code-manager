import { useCallback, useEffect, useRef, useState } from "react";
import { api, type AccountState, type Project, type ServerStatus } from "../lib/api";
import { parentPath } from "../lib/format";
import { PanelLeftIcon, HistoryIcon, VscodeSidebarIcon, SunIcon, MoonIcon } from "./icons";
import { AccountMenu } from "./AccountMenu";

interface Props {
  project: Project | null;
  status: ServerStatus;
  /** hide the native webview while a dialog is up or a pane is being dragged */
  suppressed: boolean;
  firstPane: boolean;
  showProjects: boolean;
  showChats: boolean;
  /** best-effort — a locally-tracked guess, since VS Code doesn't report its
      own sidebar's open state back to us */
  vscodeSidebarOpen: boolean;
  onToggleProjects: () => void;
  onToggleChats: () => void;
  onToggleVscodeSidebar: () => void;
  onRetry: () => void;
  accounts: AccountState;
  onAccounts: (s: AccountState, restart: boolean) => void;
  onAccountError: (message: string) => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
}

export function VscodeView({
  project,
  status,
  suppressed,
  firstPane,
  showProjects,
  showChats,
  vscodeSidebarOpen,
  onToggleProjects,
  onToggleChats,
  onToggleVscodeSidebar,
  onRetry,
  accounts,
  onAccounts,
  onAccountError,
  theme,
  onToggleTheme,
}: Props) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  const [mountErr, setMountErr] = useState<string | null>(null);
  const [acctAnchor, setAcctAnchor] = useState<HTMLElement | null>(null);

  const activeAccount = accounts.accounts.find((a) => a.id === accounts.active) ?? null;

  const activeId = project?.path ?? null;
  const ready = status.phase === "ready";
  // The embedded editor is a native child webview stacked above the page, so no
  // z-index can put a popover in front of it — it has to step aside instead.
  const shouldShow = ready && !!activeId && !suppressed && !acctAnchor;

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
        className={
          "pane-top pane-head" +
          (firstPane ? " with-traffic" : "") +
          (project ? " tinted" : "")
        }
        style={
          project?.color ? ({ "--proj-color": project.color } as React.CSSProperties) : undefined
        }
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
            <HistoryIcon />
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
            <button
              className={"toggle-btn" + (vscodeSidebarOpen ? " on" : "")}
              onClick={onToggleVscodeSidebar}
              title="Toggle VS Code's sidebar"
              aria-pressed={vscodeSidebarOpen}
            >
              <VscodeSidebarIcon />
            </button>
          )}
          <button
            className="mini-btn icon-only"
            onClick={onToggleTheme}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>

          {/* Which Claude identity the embedded editor is running as. */}
          <button
            className={"acct-chip" + (activeAccount ? " custom" : "")}
            onClick={(e) => {
              const el = e.currentTarget;
              setAcctAnchor((a) => (a ? null : el));
            }}
            title={
              activeAccount
                ? `Claude account: ${activeAccount.label} (${activeAccount.hint})`
                : "Claude account: default keychain login"
            }
          >
            <span className="acct-dot" />
            {activeAccount ? activeAccount.label : "Default"}
          </button>
          {project && (
            <button
              className="mini-btn"
              onClick={() => api.showVscodeTerminal()}
              title="Open VS Code's terminal"
            >
              Terminal
            </button>
          )}
        </div>
      </header>

      {acctAnchor && (
        <AccountMenu
          state={accounts}
          anchor={acctAnchor}
          onClose={() => setAcctAnchor(null)}
          onChanged={onAccounts}
          onError={onAccountError}
        />
      )}

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
