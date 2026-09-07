import { useCallback, useEffect, useState } from "react";
import { RefreshIcon } from "./icons";
import {
  api,
  type AccountState,
  type Limits,
  type LiveUsage,
  type LiveWindow,
  type UsageWindows,
  type WindowUsage,
} from "../lib/api";

interface Props {
  onOpenDetails: () => void;
  /** whose usage this is — the meters follow the account the editor runs as */
  accounts: AccountState;
}

const EMPTY_LIMITS: Limits = { session_tokens: null, weekly_tokens: null };
// The endpoint enforces a small request budget, not a per-second rate: spend it
// too fast and every later call 429s until the window rolls. Utilisation moves
// slowly, so poll rarely, tick the clock often, and let the reload button cover
// the moments someone actually wants a fresh number.
const LIVE_REFRESH_MS = 15 * 60_000;
const CLOCK_MS = 30_000;

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

/** "3m", "2h" — how long ago the numbers were fetched. */
function agoLabel(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}

export function UsageMeters({ onOpenDetails, accounts }: Props) {
  // Token accounts are someone else's quota — the app has no standing to report
  // it, and the endpoint often refuses the read anyway. Show nothing.
  const tokenMode = accounts.active !== null;
  const [limits, setLimits] = useState<Limits>(EMPTY_LIMITS);
  const [data, setData] = useState<UsageWindows | null>(null);
  // Claude's own utilisation figures. Preferred whenever they load; the local
  // transcript estimate below is only the offline fallback.
  const [live, setLive] = useState<LiveUsage | null>(null);
  // Why the live call failed, kept so the meters can say so instead of
  // silently degrading to the "set a limit" state and looking broken.
  const [liveError, setLiveError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [reloading, setReloading] = useState(false);

  const refreshLive = useCallback((force = false) => {
    if (force) setReloading(true);
    api
      .claudeUsage(force)
      .then((u) => {
        setLive(u);
        setLiveError(null);
      })
      .catch((e) => setLiveError(String(e).replace(/^Error:\s*/, "")))
      .finally(() => setReloading(false));
  }, []);

  const refresh = useCallback((l: Limits) => {
    api
      .usageWindows(l)
      .then(setData)
      .catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    // Only a different account invalidates what is on screen; an ordinary
    // refresh keeps showing the last good numbers until new ones land.
    setLive(null);
    setLiveError(null);
    if (tokenMode) return;
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
  }, [accounts.active, tokenMode, refresh, refreshLive]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (tokenMode) return;
    const t = setInterval(() => {
      refreshLive();
      refresh(limits);
    }, LIVE_REFRESH_MS);
    return () => clearInterval(t);
  }, [limits, tokenMode, refresh, refreshLive]);

  const useLive = live !== null && (live.five_hour !== null || live.seven_day !== null);
  // A failed refresh is only worth reporting when there is nothing to show in
  // its place — otherwise the meters just keep the numbers they have.
  const showError = liveError !== null && !useLive;
  const ageMs = live ? now - live.fetched_at : 0;
  const stale = useLive && ageMs > 120_000;
  if (tokenMode) return null;
  if (!useLive && !data && !liveError) return null;

  return (
    <section className="meters">
      <header className="meters-head">
        <span className="meters-title">Usage</span>
        <span className="meters-actions">
          <button
            className={"meters-reload" + (reloading ? " spinning" : "")}
            onClick={() => {
              refreshLive(true);
              refresh(limits);
            }}
            disabled={reloading}
            title="Refresh usage now"
            aria-label="Refresh usage"
          >
            <RefreshIcon />
          </button>
          <button className="meters-link" onClick={onOpenDetails}>
            Details
          </button>
        </span>
      </header>

      {showError && <p className="meters-error">{liveError}</p>}
      {stale && <p className="meters-stale">Numbers are {agoLabel(ageMs)} old — refresh pending.</p>}

      {live !== null && useLive ? (
        <>
          <LiveMeter label="Session (5hr)" w={live.five_hour} now={now} />
          <LiveMeter label="Weekly (7 day)" w={live.seven_day} now={now} />
          {live.seven_day_opus && (
            <LiveMeter label="Weekly (Opus)" w={live.seven_day_opus} now={now} />
          )}
        </>
      ) : (
        data && (
          <>
            {/* Offline fallback: percentages against a limit the user typed in. */}
            <Meter
              label="Session (5hr)"
              w={data.session}
              now={data.now}
              onSetLimit={onOpenDetails}
            />
            <Meter
              label="Weekly (7 day)"
              w={data.weekly}
              now={data.now}
              rolling
              onSetLimit={onOpenDetails}
            />
          </>
        )
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
