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
  const missingLimit = !data.session.limit || !data.weekly.limit;

  return (
    <section className="meters">
      <header className="meters-head">
        <span className="meters-title">Usage</span>
        <button className="meters-link" onClick={onOpenDetails}>
          {missingLimit ? "Set limits" : "Details"}
        </button>
      </header>

      {/* The 5-hour block has a real anchor, so its countdown is meaningful.
          The weekly figure is a trailing 7 days — there is no reset instant to
          show without knowing the plan's cycle. */}
      <Meter label="Session (5hr)" w={data.session} now={data.now} />
      <Meter label="Weekly (7 day)" w={data.weekly} now={data.now} rolling />
    </section>
  );
}

function Meter({
  label,
  w,
  now,
  rolling = false,
}: {
  label: string;
  w: WindowUsage;
  now: number;
  rolling?: boolean;
}) {
  const pct = w.limit ? Math.min(100, Math.round((w.tokens / w.limit) * 100)) : null;
  const until = untilLabel(w.resets_at, now);

  let sub: string;
  if (w.messages === 0) sub = "No activity yet";
  else if (rolling) sub = `Trailing 7 days · ${formatTokens(w.tokens)} tokens`;
  else if (until) sub = `Resets in ${until}`;
  else sub = `${formatTokens(w.tokens)} tokens`;

  return (
    <div className="meter">
      <div className="meter-top">
        <span className="meter-label">{label}</span>
        <span className="meter-value">
          {pct !== null ? `${pct}%` : formatTokens(w.tokens)}
        </span>
      </div>
      <div className="meter-track">
        {pct !== null && (
          <span
            className={"meter-fill" + (pct >= 90 ? " hot" : "")}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
      <div className="meter-sub">{sub}</div>
    </div>
  );
}
