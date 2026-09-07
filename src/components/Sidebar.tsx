import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Project } from "../lib/api";
import { fuzzyScore, parentPath, relativeTime } from "../lib/format";
import { UsageMeters } from "./UsageMeters";
import { SearchIcon, FolderIcon, GripIcon } from "./icons";
import { ProjectMenu } from "./ProjectMenu";

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
  onReorder: (order: string[]) => void;
  onColor: (p: Project, color: string | null) => void;
  onUploadIcon: (p: Project) => void;
  onClearIcon: (p: Project) => void;
  onAdd: () => void;
  onImport: () => void;
  onShowUsage: () => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  rowRefs: React.RefObject<(HTMLDivElement | null)[]>;
}

type GroupKey = "fav" | "other" | "results";

interface Group {
  key: GroupKey;
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
    return scored.length ? [{ key: "results", label: "Results", items: scored.map((x) => x.p) }] : [];
  }
  // Manual order — the array is the order. Favourites float to the top but keep
  // their own manual order; nothing reorders on select.
  const favorites = projects.filter((p) => p.favorite);
  const others = projects.filter((p) => !p.favorite);
  const groups: Group[] = [];
  if (favorites.length) groups.push({ key: "fav", label: "Favourites", items: favorites });
  if (others.length) groups.push({ key: "other", label: "Projects", items: others });
  return groups;
}

export function flatList(projects: Project[], query: string): Project[] {
  return buildGroups(projects, query).flatMap((g) => g.items);
}

const DRAG_THRESHOLD = 4;
const EDGE_ZONE = 48; // px from list edge where auto-scroll kicks in
const EDGE_SPEED = 16; // max px per frame
const SHIFT_EASE = "transform 180ms cubic-bezier(0.2, 0.75, 0.3, 1)";

interface DragState {
  path: string;
  group: GroupKey;
  pointerId: number;
  handle: HTMLElement;
  startX: number;
  startY: number;
  startContentY: number;
  active: boolean;
  index: number;
  order: string[];
  /** original layout centres, in list-content space (survives scrolling) */
  centers: number[];
  height: number;
  target: number;
  clientY: number;
  frame: number | null;
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
  onReorder,
  onColor,
  onUploadIcon,
  onClearIcon,
  onAdd,
  onImport,
  onShowUsage,
  searchRef,
  rowRefs,
}: Props) {
  const groups = useMemo(() => buildGroups(projects, query), [projects, query]);
  const [menu, setMenu] = useState<{ path: string; anchor: HTMLElement } | null>(null);
  const menuProject = menu ? projects.find((p) => p.path === menu.path) ?? null : null;
  const canDrag = !query.trim();

  // ── pointer-based drag reorder (WKWebView has no usable HTML5 DnD) ──────────
  // The dragged row follows the pointer 1:1 while its neighbours slide out of
  // the way, so the list reads like a native sortable list rather than a
  // drop-line indicator.
  const [dragPath, setDragPath] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const drag = useRef<DragState | null>(null);

  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  const rowEl = (path: string) => rowEls.current.get(path) ?? null;

  const contentY = useCallback((clientY: number) => {
    const list = listRef.current;
    if (!list) return clientY;
    return clientY - list.getBoundingClientRect().top + list.scrollTop;
  }, []);

  /** Position the dragged row under the pointer and shift its neighbours. */
  const paint = useCallback(() => {
    const d = drag.current;
    if (!d || !d.active) return;
    d.frame = null;

    const dragged = rowEl(d.path);
    if (!dragged) return;

    const first = d.centers[0];
    const last = d.centers[d.centers.length - 1];
    const raw = contentY(d.clientY) - d.startContentY;
    const dy = Math.max(first - d.centers[d.index], Math.min(last - d.centers[d.index], raw));
    dragged.style.transform = `translate3d(0, ${dy}px, 0)`;

    const center = d.centers[d.index] + dy;
    let target = 0;
    for (let j = 0; j < d.centers.length; j++) {
      if (j !== d.index && d.centers[j] < center) target++;
    }
    d.target = target;

    for (let j = 0; j < d.order.length; j++) {
      if (j === d.index) continue;
      const el = rowEl(d.order[j]);
      if (!el) continue;
      let shift = 0;
      if (j > d.index && j <= target) shift = -d.height;
      else if (j < d.index && j >= target) shift = d.height;
      el.style.transform = shift ? `translate3d(0, ${shift}px, 0)` : "";
    }
  }, [contentY]);

  const schedule = useCallback(() => {
    const d = drag.current;
    if (!d || !d.active || d.frame !== null) return;
    d.frame = requestAnimationFrame(() => paint());
  }, [paint]);

  /** Scroll the list when the pointer sits near its top/bottom edge. */
  const autoScroll = useCallback(() => {
    const d = drag.current;
    const list = listRef.current;
    if (!d || !d.active || !list) return;
    const r = list.getBoundingClientRect();
    let delta = 0;
    if (d.clientY < r.top + EDGE_ZONE) {
      delta = -EDGE_SPEED * Math.min(1, (r.top + EDGE_ZONE - d.clientY) / EDGE_ZONE);
    } else if (d.clientY > r.bottom - EDGE_ZONE) {
      delta = EDGE_SPEED * Math.min(1, (d.clientY - (r.bottom - EDGE_ZONE)) / EDGE_ZONE);
    }
    if (delta) {
      const before = list.scrollTop;
      list.scrollTop = before + delta;
      if (list.scrollTop !== before) paint();
    }
    requestAnimationFrame(autoScroll);
  }, [paint]);

  const startDrag = useCallback(
    (d: DragState) => {
      const items = groupsRef.current.find((g) => g.key === d.group)?.items ?? [];
      const list = listRef.current;
      if (items.length < 2 || !list) return false;

      const order = items.map((p) => p.path);
      const index = order.indexOf(d.path);
      if (index < 0) return false;

      const listTop = list.getBoundingClientRect().top;
      const centers: number[] = [];
      let height = 0;
      for (const path of order) {
        const el = rowEl(path);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        centers.push(r.top - listTop + list.scrollTop + r.height / 2);
        height = r.height;
      }
      // Row pitch, not row height — rows may be separated by margins.
      if (centers.length > 1) height = centers[1] - centers[0];

      d.active = true;
      d.order = order;
      d.index = index;
      d.centers = centers;
      d.height = height;
      d.target = index;

      for (let j = 0; j < order.length; j++) {
        const el = rowEl(order[j]);
        if (el) el.style.transition = j === index ? "none" : SHIFT_EASE;
      }
      document.body.classList.add("dnd-active");
      setDragPath(d.path);
      requestAnimationFrame(autoScroll);
      paint();
      return true;
    },
    [autoScroll, paint],
  );

  const finishDrag = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.frame !== null) cancelAnimationFrame(d.frame);
    try {
      d.handle.releasePointerCapture(d.pointerId);
    } catch {
      /* pointer already gone */
    }
    if (!d.active) return;

    document.body.classList.remove("dnd-active");
    for (const path of d.order) {
      const el = rowEl(path);
      if (!el) continue;
      el.style.transition = "";
      el.style.transform = "";
    }
    setDragPath(null);

    if (d.target !== d.index) {
      const paths = d.order.filter((x) => x !== d.path);
      paths.splice(d.target, 0, d.path);
      const other = (key: GroupKey) =>
        groupsRef.current.find((g) => g.key === key)?.items.map((p) => p.path) ?? [];
      const favPaths = d.group === "fav" ? paths : other("fav");
      const otherPaths = d.group === "other" ? paths : other("other");
      onReorder([...favPaths, ...otherPaths]);
    }
  }, [onReorder]);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      d.clientY = e.clientY;

      if (!d.active) {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return;
        if (!startDrag(d)) {
          drag.current = null;
          return;
        }
      }
      e.preventDefault();
      schedule();
    }

    function onUp(e: PointerEvent) {
      if (drag.current && e.pointerId !== drag.current.pointerId) return;
      finishDrag();
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && drag.current) {
        const d = drag.current;
        d.target = d.index; // snap back, no reorder
        finishDrag();
      }
    }

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [finishDrag, schedule, startDrag]);

  function onHandlePointerDown(e: React.PointerEvent<HTMLElement>, p: Project, group: GroupKey) {
    if (!canDrag || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    drag.current = {
      path: p.path,
      group,
      pointerId: e.pointerId,
      handle,
      startX: e.clientX,
      startY: e.clientY,
      startContentY: contentY(e.clientY),
      active: false,
      index: 0,
      order: [],
      centers: [],
      height: 0,
      target: 0,
      clientY: e.clientY,
      frame: null,
    };
  }

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

      <div className="proj-list" ref={listRef}>
        {projects.length === 0 && (
          <div className="side-empty">
            <p>No projects yet.</p>
            <p className="hint">Add a folder or import from VS Code below.</p>
          </div>
        )}
        {projects.length > 0 && groups.length === 0 && (
          <div className="side-empty">
            <p>No matches for “{query}”.</p>
          </div>
        )}

        {groups.map((group) => (
          <section key={group.key}>
            <h3 className="group-label">{group.label}</h3>
            {group.items.map((p) => {
              rowIndex++;
              const idx = rowIndex;
              return (
                <div
                  key={p.path}
                  ref={(el) => {
                    rowRefs.current[idx] = el;
                    if (el) rowEls.current.set(p.path, el);
                    else rowEls.current.delete(p.path);
                  }}
                  className={
                    "row" +
                    (p.path === activeId ? " active" : "") +
                    (idx === selectedIndex ? " selected" : "") +
                    (dragPath === p.path ? " dragging" : "") +
                    (dragPath && dragPath !== p.path ? " dnd-idle" : "")
                  }
                  style={p.color ? ({ "--proj-color": p.color } as React.CSSProperties) : undefined}
                  onClick={() => onSelect(p)}
                  title={p.path}
                >
                  <span
                    className={"drag-handle" + (canDrag ? "" : " off")}
                    role="button"
                    aria-label="Reorder project"
                    onPointerDown={(e) => onHandlePointerDown(e, p, group.key)}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <GripIcon />
                  </span>
                  <span className="avatar" aria-hidden="true">
                    {p.icon ? (
                      <img className="avatar-img" src={p.icon} alt="" draggable={false} />
                    ) : (
                      p.name.slice(0, 1).toUpperCase()
                    )}
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
                    className={"row-menu" + (menu?.path === p.path ? " open" : "")}
                    onClick={(e) => {
                      e.stopPropagation();
                      const anchor = e.currentTarget;
                      setMenu((m) => (m?.path === p.path ? null : { path: p.path, anchor }));
                    }}
                    aria-label="Project options"
                  >
                    ⋯
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

      {menu && menuProject && (
        <ProjectMenu
          project={menuProject}
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          onToggleFavorite={() => {
            setMenu(null);
            onToggleFavorite(menuProject);
          }}
          onColor={(c) => onColor(menuProject, c)}
          onUploadIcon={() => {
            setMenu(null);
            onUploadIcon(menuProject);
          }}
          onClearIcon={() => {
            setMenu(null);
            onClearIcon(menuProject);
          }}
          onRemove={() => {
            setMenu(null);
            onRemove(menuProject);
          }}
        />
      )}
    </aside>
  );
}
