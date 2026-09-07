import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, type AccountState } from "../lib/api";

interface Props {
  state: AccountState;
  anchor: HTMLElement;
  onClose: () => void;
  onChanged: (s: AccountState, restart: boolean) => void;
  onError: (message: string) => void;
}

export function AccountMenu({ state, anchor, onClose, onChanged, onError }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ top: -9999, left: -9999 });
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [shell, setShell] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect();
    const m = ref.current?.getBoundingClientRect();
    const w = m?.width ?? 260;
    const h = m?.height ?? 200;
    let left = a.right - w;
    let top = a.bottom + 6;
    if (left < 8) left = 8;
    if (top + h > window.innerHeight - 8) top = a.top - h - 6;
    setPos({ top, left });
  }, [anchor, adding, shell.length]);

  useEffect(() => {
    api
      .discoverShellAccounts()
      .then(setShell)
      .catch(() => {});
  }, [state.accounts.length]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [anchor, onClose]);

  async function pick(id: string | null) {
    if (id === state.active) return onClose();
    setBusy(true);
    try {
      onChanged(await api.setActiveAccount(id), true);
      onClose();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      onChanged(await api.addAccount(label, token), false);
      setToken("");
      setLabel("");
      setAdding(false);
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function adopt(found: string) {
    setBusy(true);
    try {
      onChanged(await api.adoptShellAccount(found, ""), false);
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function forget(id: string) {
    setBusy(true);
    try {
      onChanged(await api.removeAccount(id), id === state.active);
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="acct-menu" ref={ref} style={{ top: pos.top, left: pos.left }}>
      <div className="pm-section-label">Claude account</div>

      <button
        className={"acct-row" + (state.active === null ? " on" : "")}
        onClick={() => pick(null)}
        disabled={busy}
      >
        <span className="acct-tick">{state.active === null ? "✓" : ""}</span>
        <span className="acct-text">
          <span className="acct-name">Default login</span>
          <span className="acct-hint">No CLAUDE_CODE_OAUTH_TOKEN</span>
        </span>
      </button>

      {state.accounts.map((a) => (
        <div key={a.id} className="acct-line">
          <button
            className={"acct-row" + (state.active === a.id ? " on" : "")}
            onClick={() => pick(a.id)}
            disabled={busy}
          >
            <span className="acct-tick">{state.active === a.id ? "✓" : ""}</span>
            <span className="acct-text">
              <span className="acct-name">{a.label}</span>
              <span className="acct-hint">{a.hint}</span>
            </span>
          </button>
          <button
            className="acct-forget"
            onClick={() => forget(a.id)}
            disabled={busy}
            title="Forget this token"
            aria-label={`Forget ${a.label}`}
          >
            ✕
          </button>
        </div>
      ))}

      {shell.length > 0 && !adding && (
        <>
          <div className="pm-sep" />
          <div className="pm-section-label">Found in your shell profile</div>
          {shell.map((found) => (
            <button key={found} className="pm-item" onClick={() => adopt(found)} disabled={busy}>
              + {found}
            </button>
          ))}
        </>
      )}

      <div className="pm-sep" />
      {adding ? (
        <div className="acct-form">
          <input
            className="input sm"
            placeholder="Name (e.g. Work)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <input
            className="input sm"
            type="password"
            placeholder="sk-ant-oat01-…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && token && void save()}
            autoFocus
          />
          <div className="acct-form-foot">
            <button className="ghost-btn" onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </button>
            <button className="primary-btn" onClick={save} disabled={busy || !token}>
              Save
            </button>
          </div>
          <p className="acct-note">Stored in your login keychain, not in the app's files.</p>
        </div>
      ) : (
        <button className="pm-item" onClick={() => setAdding(true)}>
          Add token…
        </button>
      )}

      <p className="acct-note">Switching restarts the editor server; open tabs reload.</p>
    </div>,
    document.body,
  );
}
