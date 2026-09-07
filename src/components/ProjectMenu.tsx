import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type Project } from "../lib/api";

export const PROJECT_COLORS = [
  "#6e8bff",
  "#8b7bff",
  "#c58fff",
  "#f38ec4",
  "#ff6b6b",
  "#f4a54a",
  "#f4c04a",
  "#5bd6a0",
  "#4bc8d6",
  "#8b93a5",
] as const;

interface Props {
  project: Project;
  anchor: HTMLElement;
  onClose: () => void;
  onToggleFavorite: () => void;
  onColor: (color: string | null) => void;
  onUploadIcon: () => void;
  onClearIcon: () => void;
  onRemove: () => void;
}

export function ProjectMenu({
  project,
  anchor,
  onClose,
  onToggleFavorite,
  onColor,
  onUploadIcon,
  onClearIcon,
  onRemove,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: -9999, left: -9999 });

  // Anything not in the preset row came from the native colour panel.
  const preset = PROJECT_COLORS.includes(project.color as (typeof PROJECT_COLORS)[number]);
  const custom = project.color && !preset ? project.color : null;

  // The panel streams a colour as you drag inside it. Persist at a lazy rate so
  // the app tints live without a write per frame; the final value always lands
  // on the input's change event.
  const lastLive = useRef(0);
  const onLive = useCallback(
    (value: string) => {
      const now = Date.now();
      if (now - lastLive.current < 200) return;
      lastLive.current = now;
      onColor(value);
    },
    [onColor],
  );

  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect();
    const m = ref.current?.getBoundingClientRect();
    const w = m?.width ?? 208;
    const h = m?.height ?? 180;
    let left = a.right - w;
    let top = a.bottom + 6;
    if (left < 8) left = 8;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - 8 - w;
    if (top + h > window.innerHeight - 8) top = a.top - h - 6;
    setPos({ top, left });
  }, [anchor]);

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

  return createPortal(
    <div className="proj-menu" ref={ref} style={{ top: pos.top, left: pos.left }}>
      <button className="pm-item" onClick={onToggleFavorite}>
        <span className={"pm-star" + (project.favorite ? " on" : "")}>
          {project.favorite ? "★" : "☆"}
        </span>
        {project.favorite ? "Remove from Favourites" : "Add to Favourites"}
      </button>

      <div className="pm-sep" />
      <div className="pm-section-label">Colour</div>
      <div className="pm-colors">
        {PROJECT_COLORS.map((c) => (
          <button
            key={c}
            className={"pm-swatch" + (project.color === c ? " on" : "")}
            style={{ background: c }}
            onClick={() => onColor(c)}
            aria-label={`Colour ${c}`}
          />
        ))}
        <label
          className={"pm-swatch pm-custom" + (custom ? " on" : "")}
          style={custom ? { background: custom } : undefined}
          title="Custom colour…"
        >
          <input
            type="color"
            value={project.color ?? "#6e8bff"}
            onInput={(e) => onLive(e.currentTarget.value)}
            onChange={(e) => onColor(e.currentTarget.value)}
            aria-label="Custom colour"
          />
        </label>
        <button
          className={"pm-swatch pm-none" + (!project.color ? " on" : "")}
          onClick={() => onColor(null)}
          title="No colour"
          aria-label="No colour"
        >
          ⊘
        </button>
      </div>

      <div className="pm-sep" />
      <button className="pm-item" onClick={onUploadIcon}>
        {project.icon ? "Replace icon…" : "Upload icon…"}
      </button>
      {project.icon && (
        <button className="pm-item" onClick={onClearIcon}>
          Remove icon
        </button>
      )}

      <div className="pm-sep" />
      <button className="pm-item danger" onClick={onRemove}>
        Remove from Easy Switch
      </button>
    </div>,
    document.body,
  );
}
