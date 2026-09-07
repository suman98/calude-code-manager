import { useCallback, useRef } from "react";

interface Props {
  /** current width of the pane to the left of this handle */
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  label: string;
}

/**
 * Drag handle between two panes. The embedded VS Code is a native webview
 * layered over the page, so it swallows pointer events the moment the cursor
 * crosses into it — the parent hides it for the duration of a drag.
 */
export function Resizer({ width, min, max, onResize, onDragStart, onDragEnd, label }: Props) {
  const start = useRef({ x: 0, w: 0 });

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      start.current = { x: e.clientX, w: width };
      onDragStart();
      document.body.classList.add("resizing");

      const move = (ev: PointerEvent) => {
        const next = Math.min(max, Math.max(min, start.current.w + (ev.clientX - start.current.x)));
        onResize(next);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.classList.remove("resizing");
        onDragEnd();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [width, min, max, onResize, onDragStart, onDragEnd],
  );

  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onResize(min)}
    >
      <span className="resizer-grip" />
    </div>
  );
}
