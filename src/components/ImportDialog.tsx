import { useEffect, useMemo, useState } from "react";
import { api, type Discovered, type Project } from "../lib/api";
import { parentPath, relativeTime } from "../lib/format";

interface Props {
  onClose: () => void;
  onImported: (projects: Project[]) => void;
}

export function ImportDialog({ onClose, onImported }: Props) {
  const [items, setItems] = useState<Discovered[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .discover()
      .then(setItems)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const available = useMemo(
    () => (items ?? []).filter((i) => !i.already_added),
    [items],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return available;
    return available.filter(
      (i) => i.name.toLowerCase().includes(q) || i.path.toLowerCase().includes(q),
    );
  }, [available, query]);

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }

  const allShownSelected =
    filtered.length > 0 && filtered.every((i) => selected.has(i.path));

  function toggleAllShown() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allShownSelected) filtered.forEach((i) => next.delete(i.path));
      else filtered.forEach((i) => next.add(i.path));
      return next;
    });
  }

  async function doImport() {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      const projects = await api.addMany([...selected]);
      onImported(projects);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <header className="dialog-head">
          <div>
            <h2>Import from VSCode</h2>
            <p className="muted">
              Folders VSCode has opened before. Already-added projects are hidden.
            </p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {error && <div className="notice error inline">{error}</div>}

        {items === null && !error && (
          <div className="dialog-body center muted">Scanning VSCode history…</div>
        )}

        {items !== null && available.length === 0 && (
          <div className="dialog-body center muted">
            Nothing new to import — every folder VSCode knows about is already here.
          </div>
        )}

        {available.length > 0 && (
          <>
            <div className="dialog-toolbar">
              <input
                autoFocus
                className="input sm"
                placeholder="Filter…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button className="ghost-btn" onClick={toggleAllShown}>
                {allShownSelected ? "Clear" : "Select all"}
              </button>
            </div>

            <ul className="dialog-body list">
              {filtered.map((i) => (
                <li
                  key={i.path}
                  className={"pick-row" + (selected.has(i.path) ? " on" : "")}
                  onClick={() => toggle(i.path)}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(i.path)}
                    readOnly
                    tabIndex={-1}
                  />
                  <span className="pick-name">{i.name}</span>
                  <span className="pick-path">{parentPath(i.path)}</span>
                  <span className="pick-time muted">
                    {relativeTime(i.modified) || "—"}
                  </span>
                </li>
              ))}
              {filtered.length === 0 && (
                <li className="muted center pad">No matches.</li>
              )}
            </ul>
          </>
        )}

        <footer className="dialog-foot">
          <span className="muted">{selected.size} selected</span>
          <div className="row-gap">
            <button className="ghost-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary-btn"
              disabled={selected.size === 0 || busy}
              onClick={doImport}
            >
              {busy ? "Adding…" : `Add ${selected.size || ""}`.trim()}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
