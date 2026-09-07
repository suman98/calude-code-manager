import { useMemo } from "react";
import { type Project } from "../lib/api";
import { fuzzyScore, parentPath, relativeTime } from "../lib/format";
import { UsageMeters } from "./UsageMeters";
import { SearchIcon, FolderIcon } from "./icons";

interface Props {
  width: number;
  firstPane: boolean;
  projects: Project[];
  activeId: string | null;
  openIds: Set<string>;
  query: string;
  selectedIndex: number;
  onQuery: (q: string) => void;
  onSelect: (p: Project) => void;
  onToggleFavorite: (p: Project) => void;
  onRemove: (p: Project) => void;
  onAdd: () => void;
  onImport: () => void;
  onShowUsage: () => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  rowRefs: React.RefObject<(HTMLDivElement | null)[]>;
}

interface Group {
  label: string;
  items: Project[];
}

function buildGroups(projects: Project[], query: string): Group[] {
  const q = query.trim();
  if (q) {
    const scored = projects
      .map((p) => ({
        p,
        score: Math.max(fuzzyScore(q, p.name) + 4, fuzzyScore(q, parentPath(p.path))),
      }))
      .filter((x) => x.score > -1)
      .sort((a, b) => b.score - a.score || (b.p.last_opened ?? 0) - (a.p.last_opened ?? 0));
    return scored.length ? [{ label: "Results", items: scored.map((x) => x.p) }] : [];
  }
  const byRecency = (a: Project, b: Project) =>
    (b.last_opened ?? b.added) - (a.last_opened ?? a.added);
  const favorites = projects.filter((p) => p.favorite).sort(byRecency);
  const recents = projects.filter((p) => !p.favorite).sort(byRecency);
  const groups: Group[] = [];
  if (favorites.length) groups.push({ label: "Favorites", items: favorites });
  if (recents.length) groups.push({ label: "Recent", items: recents });
  return groups;
}

export function flatList(projects: Project[], query: string): Project[] {
  return buildGroups(projects, query).flatMap((g) => g.items);
}

export function Sidebar({
  width,
  firstPane,
  projects,
  activeId,
  openIds,
  query,
  selectedIndex,
  onQuery,
  onSelect,
  onToggleFavorite,
  onRemove,
  onAdd,
  onImport,
  onShowUsage,
  searchRef,
  rowRefs,
}: Props) {
  const groups = useMemo(() => buildGroups(projects, query), [projects, query]);
  let rowIndex = -1;

  return (
    <aside className="sidebar" style={{ width }}>
      <div className={"pane-top" + (firstPane ? " with-traffic" : "")} data-tauri-drag-region>
        <span className="brand">
          <span className="glyph">⇄</span> Easy Switch
        </span>
      </div>

      <div className="searchwrap">
        <SearchIcon className="search-icon" />
        <input
          ref={searchRef}
          className="search"
          placeholder="Search projects…"
          value={query}
          autoFocus
          onChange={(e) => onQuery(e.target.value)}
        />
        {query && (
          <button className="clear-btn" onClick={() => onQuery("")} aria-label="Clear">
            ✕
          </button>
        )}
      </div>

      <div className="proj-list">
        {projects.length === 0 && (
          <div className="side-empty">
            <p>No projects yet.</p>
            <p className="hint">Add a folder or import from VSCode below.</p>
          </div>
        )}
        {projects.length > 0 && groups.length === 0 && (
          <div className="side-empty">
            <p>No matches for “{query}”.</p>
          </div>
        )}

        {groups.map((group) => (
          <section key={group.label}>
            <h3 className="group-label">{group.label}</h3>
            {group.items.map((p) => {
              rowIndex++;
              const idx = rowIndex;
              return (
                <div
                  key={p.path}
                  ref={(el) => {
                    rowRefs.current[idx] = el;
                  }}
                  className={
                    "row" +
                    (p.path === activeId ? " active" : "") +
                    (idx === selectedIndex ? " selected" : "")
                  }
                  onClick={() => onSelect(p)}
                  title={p.path}
                >
                  <button
                    className={"star" + (p.favorite ? " on" : "")}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleFavorite(p);
                    }}
                    aria-label={p.favorite ? "Unfavorite" : "Favorite"}
                  >
                    {p.favorite ? "★" : "☆"}
                  </button>
                  <span className="avatar" aria-hidden="true">
                    {p.name.slice(0, 1).toUpperCase()}
                    <span className={"dot" + (openIds.has(p.path) ? " live" : "")} />
                  </span>
                  <span className="meta">
                    <span className="name">{p.name}</span>
                    <span className="path">{parentPath(p.path)}</span>
                  </span>
                  <span className={"when" + (openIds.has(p.path) ? " running" : "")}>
                    {openIds.has(p.path)
                      ? "open"
                      : p.last_opened
                        ? relativeTime(p.last_opened)
                        : ""}
                  </span>
                  <button
                    className="remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(p);
                    }}
                    aria-label="Remove"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </section>
        ))}
      </div>

      <UsageMeters onOpenDetails={onShowUsage} />

      <div className="sidebar-foot">
        <button className="ghost-btn" onClick={onImport}>
          Import
        </button>
        <button className="primary-btn" onClick={onAdd}>
          <FolderIcon /> Add folder
        </button>
      </div>
    </aside>
  );
}
