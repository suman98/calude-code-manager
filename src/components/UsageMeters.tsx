import { useCallback, useEffect, useState } from "react";
import { api, type Limits, type UsageWindows, type WindowUsage } from "../lib/api";
import { formatTokens } from "../lib/format";

interface Props {
  onOpenDetails: () => void;
}

const EMPTY_LIMITS: Limits = { session_tokens: null, weekly_tokens: null };

/** "2h", "4d", "18m" — the coarse countdown Claude Code shows. */
function untilLabel(resetsAt: number | null, now: number): string | null {
  if (!resetsAt) return null;
  const ms = resetsAt - now;
  if (ms <= 0) return "now";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = ms / 3_600_000;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

export function UsageMeters({ onOpenDetails }: Props) {
  const [limits, setLimits] = useState<Limits>(EMPTY_LIMITS);
  const [data, setData] = useState<UsageWindows | null>(null);

  const refresh = useCallback((l: Limits) => {
    api
      .usageWindows(l)
      .then(setData)
      .catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .getLimits()
      .then((l) => {
        if (!alive) return;
        setLimits(l);
        refresh(l);
      })
      .catch(() => refresh(EMPTY_LIMITS));
    return () => {
      alive = false;
    };
  }, [refresh]);

  useEffect(() => {
    const t = setInterval(() => refresh(limits), 60_000);
    return () => clearInterval(t);
  }, [limits, refresh]);

  if (!data) return null;

  return (
    <button className="meters" onClick={onOpenDetails} title="Open the full usage report">
      <span className="meters-title">Usage</span>
      <Meter label="Session (5hr)" w={data.session} now={data.now} />
      <Meter label="Weekly (7 day)" w={data.weekly} now={data.now} />
    </button>
  );
}

function Meter({ label, w, now }: { label: string; w: WindowUsage; now: number }) {
  const pct = w.limit ? Math.min(100, Math.round((w.tokens / w.limit) * 100)) : null;
  // With no configured limit the bar still needs a length: scale it by how far
  // through the window we are, so it reads as progress rather than a fake quota.
  const elapsed =
    w.window_start && w.resets_at
      ? Math.min(100, Math.max(0, ((now - w.window_start) / (w.resets_at - w.window_start)) * 100))
      : 0;
  const width = pct ?? elapsed;
  const until = untilLabel(w.resets_at, now);

  return (
    <span className="meter">
      <span className="meter-top">
        <span className="meter-label">{label}</span>
        <span className="meter-value">{pct !== null ? `${pct}%` : formatTokens(w.tokens)}</span>
      </span>
      <span className="meter-track">
        <span
          className={"meter-fill" + (pct !== null && pct >= 90 ? " hot" : "")}
          style={{ width: `${width}%` }}
        />
      </span>
      <span className="meter-sub">
        {until ? `Resets in ${until}` : "No activity in this window"}
        {pct === null && w.messages > 0 ? " · set a limit for %" : ""}
      </span>
    </span>
  );
}
