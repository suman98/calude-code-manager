import { useCallback, useEffect, useState } from "react";
import {
  api,
  type Limits,
  type LiveUsage,
  type LiveWindow,
  type UsageWindows,
  type WindowUsage,
} from "../lib/api";

interface Props {
  onOpenDetails: () => void;
}

const EMPTY_LIMITS: Limits = { session_tokens: null, weekly_tokens: null };
const LIVE_REFRESH_MS = 60_000;

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
  // Claude's own utilisation figures. Preferred whenever they load; the local
  // transcript estimate below is only the offline fallback.
  const [live, setLive] = useState<LiveUsage | null>(null);
  const [liveFailed, setLiveFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const refreshLive = useCallback(() => {
    api
      .claudeUsage()
      .then((u) => {
        setLive(u);
        setLiveFailed(false);
      })
      .catch(() => setLiveFailed(true));
  }, []);

  const refresh = useCallback((l: Limits) => {
    api
      .usageWindows(l)
      .then(setData)
      .catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    refreshLive();
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
  }, [refresh, refreshLive]);

  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      refreshLive();
      refresh(limits);
    }, LIVE_REFRESH_MS);
    return () => clearInterval(t);
  }, [limits, refresh, refreshLive]);

  const useLive = live !== null && (live.five_hour !== null || live.seven_day !== null);
  if (!useLive && !data) return null;

  return (
    <section className="meters">
      <header className="meters-head">
        <span className="meters-title">Usage</span>
        <button className="meters-link" onClick={onOpenDetails}>
          {useLive || !liveFailed ? "Details" : "Set limits"}
        </button>
      </header>

      {useLive ? (
        <>
          <LiveMeter label="Session (5hr)" w={live!.five_hour} now={now} />
          <LiveMeter label="Weekly (7 day)" w={live!.seven_day} now={now} />
          {live!.seven_day_opus && (
            <LiveMeter label="Weekly (Opus)" w={live!.seven_day_opus} now={now} />
          )}
        </>
      ) : (
        <>
          {/* Offline fallback: percentages against a limit the user typed in. */}
          <Meter label="Session (5hr)" w={data!.session} now={data!.now} onSetLimit={onOpenDetails} />
          <Meter
            label="Weekly (7 day)"
            w={data!.weekly}
            now={data!.now}
            rolling
            onSetLimit={onOpenDetails}
          />
        </>
      )}
    </section>
  );
}

function level(pct: number): string {
  return pct >= 90 ? " hot" : pct >= 75 ? " warn" : "";
}

function Bar({ pct }: { pct: number }) {
  return (
    <div className="meter-track">
      <span className={"meter-fill" + level(pct)} style={{ width: `${pct}%` }} />
    </div>
  );
}

function LiveMeter({ label, w, now }: { label: string; w: LiveWindow | null; now: number }) {
  if (!w) return null;
  const pct = Math.min(100, Math.max(0, Math.round(w.utilization)));
  const until = untilLabel(w.resets_at, now);

  return (
    <div className="meter">
      <div className="meter-top">
        <span className="meter-label">{label}</span>
        <span className={"meter-value" + level(pct)}>{pct}%</span>
      </div>
      <Bar pct={pct} />
      <div className="meter-sub">{until ? `Resets in ${until}` : "No activity yet"}</div>
    </div>
  );
}

function Meter({
  label,
  w,
  now,
  rolling = false,
  onSetLimit,
}: {
  label: string;
  w: WindowUsage;
  now: number;
  rolling?: boolean;
  onSetLimit: () => void;
}) {
  const pct = w.limit ? Math.min(100, Math.round((w.tokens / w.limit) * 100)) : null;
  const until = untilLabel(w.resets_at, now);

  let sub: string;
  if (w.messages === 0) sub = "No activity yet";
  else if (pct === null) sub = "Set a limit to track usage";
  else if (rolling) sub = "Trailing 7 days";
  else if (until) sub = `Resets in ${until}`;
  else sub = "Rolling 5 hours";

  return (
    <div className="meter">
      <div className="meter-top">
        <span className="meter-label">{label}</span>
        {pct !== null ? (
          <span className={"meter-value" + level(pct)}>{pct}%</span>
        ) : (
          <button className="meter-set" onClick={onSetLimit}>
            Set limit
          </button>
        )}
      </div>
      {pct === null ? (
        <div className="meter-track unset">
          <span className="meter-fill" style={{ width: "0%" }} />
        </div>
      ) : (
        <Bar pct={pct} />
      )}
      <div className="meter-sub">{sub}</div>
    </div>
  );
}
