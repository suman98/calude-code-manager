import { useCallback, useEffect, useRef, useState } from "react";
import { hexToHsv, hsvToHex, type Hsv } from "../lib/color";

interface Props {
  hex: string;
  /** fired continuously while dragging, throttled by the caller */
  onLive: (hex: string) => void;
  /** fired once, on release — always the final value */
  onCommit: (hex: string) => void;
}

/**
 * A self-contained saturation/value square + hue strip, so choosing a colour
 * never depends on the WebView's own colour panel — `<input type="color">`
 * can silently no-op inside a Tauri child window.
 */
export function ColorPicker({ hex, onLive, onCommit }: Props) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(hex));
  const dragging = useRef<"sv" | "hue" | null>(null);
  const svRef = useRef<HTMLDivElement | null>(null);
  const hueRef = useRef<HTMLDivElement | null>(null);

  // External changes (switching to a different project, or the picker being
  // reopened) resync — but never mid-drag, or the pointer would fight the prop.
  useEffect(() => {
    if (dragging.current) return;
    setHsv(hexToHsv(hex));
  }, [hex]);

  const fromSvEvent = useCallback((e: PointerEvent | React.PointerEvent) => {
    const el = svRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    return { s, v };
  }, []);

  const fromHueEvent = useCallback((e: PointerEvent | React.PointerEvent) => {
    const el = hueRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    return t * 360;
  }, []);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const kind = dragging.current;
      if (!kind) return;
      if (kind === "sv") {
        const next = fromSvEvent(e);
        if (!next) return;
        setHsv((prev) => {
          const merged = { ...prev, ...next };
          onLive(hsvToHex(merged.h, merged.s, merged.v));
          return merged;
        });
      } else {
        const h = fromHueEvent(e);
        if (h === null) return;
        setHsv((prev) => {
          const merged = { ...prev, h };
          onLive(hsvToHex(merged.h, merged.s, merged.v));
          return merged;
        });
      }
    }
    function onUp() {
      if (!dragging.current) return;
      dragging.current = null;
      setHsv((cur) => {
        onCommit(hsvToHex(cur.h, cur.s, cur.v));
        return cur;
      });
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [fromSvEvent, fromHueEvent, onLive, onCommit]);

  function onSvDown(e: React.PointerEvent) {
    e.preventDefault();
    dragging.current = "sv";
    const next = fromSvEvent(e);
    if (!next) return;
    setHsv((prev) => {
      const merged = { ...prev, ...next };
      onLive(hsvToHex(merged.h, merged.s, merged.v));
      return merged;
    });
  }

  function onHueDown(e: React.PointerEvent) {
    e.preventDefault();
    dragging.current = "hue";
    const h = fromHueEvent(e);
    if (h === null) return;
    setHsv((prev) => {
      const merged = { ...prev, h };
      onLive(hsvToHex(merged.h, merged.s, merged.v));
      return merged;
    });
  }

  const pureHueHex = hsvToHex(hsv.h, 1, 1);

  return (
    <div className="cpicker">
      <div
        ref={svRef}
        className="cpicker-sv"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), ${pureHueHex}` }}
        onPointerDown={onSvDown}
      >
        <span
          className="cpicker-sv-thumb"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
        />
      </div>
      <div ref={hueRef} className="cpicker-hue" onPointerDown={onHueDown}>
        <span className="cpicker-hue-thumb" style={{ left: `${(hsv.h / 360) * 100}%` }} />
      </div>
    </div>
  );
}
