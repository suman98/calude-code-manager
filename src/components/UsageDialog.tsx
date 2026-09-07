import { useEffect, useState } from "react";
import { api, type Limits, type UsageOverview } from "../lib/api";
import { formatCount, formatTokens, parentPath, relativeTime, shortModel } from "../lib/format";

interface Props {
  activePath: string | null;
  onClose: () => void;
}

function toField(v: number | null): string {
  return v ? String(v) : "";
}

export function UsageDialog({ activePath, onClose }: Props) {
  const [data, setData] = useState<UsageOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionLimit, setSessionLimit] = useState("");
  const [weeklyLimit, setWeeklyLimit] = useState("");
  const [savedLimits, setSavedLimits] = useState<Limits | null>(null);

  useEffect(() => {
    api
      .usageOverview()
      .then(setData)
      .catch((e) => setError(String(e)));
    api
      .getLimits()
      .then((l) => {
        setSavedLimits(l);
        setSessionLimit(toField(l.session_tokens));
        setWeeklyLimit(toField(l.weekly_tokens));
      })
      .catch(() => {});
  }, []);

  async function saveLimits() {
    const next: Limits = {
      session_tokens: Number(sessionLimit) || null,
      weekly_tokens: Number(weeklyLimit) || null,
    };
    try {
      setSavedLimits(await api.setLimits(next));
    } catch (e) {
      setError(String(e));
    }
  }

  const limitsDirty =
    savedLimits !== null &&
    (toField(savedLimits.session_tokens) !== sessionLimit ||
      toField(savedLimits.weekly_tokens) !== weeklyLimit);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const t = data?.totals;
  const allTokens = t
    ? t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_tokens
    : 0;
  const maxProject = data?.projects.reduce((m, p) => {
    const v = p.totals.input_tokens + p.totals.output_tokens + p.totals.cache_read_tokens + p.totals.cache_write_tokens;
    return Math.max(m, v);
  }, 0) ?? 0;

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="dialog wide" onMouseDown={(e) => e.stopPropagation()}>
        <header className="dialog-head">
          <div>
            <h2>Claude Code usage</h2>
            <p className="muted">
              Counted from your local Claude Code transcripts (<code>~/.claude/projects</code>).
            </p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {error && <div className="notice error inline">{error}</div>}
        {!data && !error && <div className="dialog-body center muted pad">Reading transcripts…</div>}

        {data && (
          <div className="dialog-body">
            <div className="stat-row">
              <Stat label="Chats" value={formatCount(t!.sessions)} />
              <Stat label="Messages" value={formatCount(t!.messages)} />
              <Stat label="Input" value={formatTokens(t!.input_tokens)} />
              <Stat label="Output" value={formatTokens(t!.output_tokens)} />
              <Stat label="Cache read" value={formatTokens(t!.cache_read_tokens)} />
              <Stat label="Cache write" value={formatTokens(t!.cache_write_tokens)} />
            </div>

            {data.by_model.length > 0 && (
              <>
                <h3 className="group-label">By model</h3>
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Msgs</th>
                      <th>In</th>
                      <th>Out</th>
                      <th>Cache r/w</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.by_model.map((m) => (
                      <tr key={m.model}>
                        <td className="cell-name">{shortModel(m.model)}</td>
                        <td>{formatCount(m.messages)}</td>
                        <td>{formatTokens(m.input_tokens)}</td>
                        <td>{formatTokens(m.output_tokens)}</td>
                        <td className="muted-cell">
                          {formatTokens(m.cache_read_tokens)} / {formatTokens(m.cache_write_tokens)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            <h3 className="group-label">Window limits</h3>
            <div className="limits-row">
              <p className="muted limits-note">
                Claude Manager measures your rolling 5-hour and 7-day usage from local transcripts. Set
                your plan's token allowance to turn those meters into percentages.
              </p>
              <label className="limit-field">
                <span>Session (5hr)</span>
                <input
                  className="input sm"
                  type="number"
                  min="0"
                  placeholder="tokens"
                  value={sessionLimit}
                  onChange={(e) => setSessionLimit(e.target.value)}
                />
              </label>
              <label className="limit-field">
                <span>Weekly (7 day)</span>
                <input
                  className="input sm"
                  type="number"
                  min="0"
                  placeholder="tokens"
                  value={weeklyLimit}
                  onChange={(e) => setWeeklyLimit(e.target.value)}
                />
              </label>
              <button className="ghost-btn" onClick={saveLimits} disabled={!limitsDirty}>
                {limitsDirty ? "Save" : "Saved"}
              </button>
            </div>

            <h3 className="group-label">By project</h3>
            <table className="usage-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Chats</th>
                  <th>Msgs</th>
                  <th>Tokens</th>
                  <th>Last used</th>
                </tr>
              </thead>
              <tbody>
                {data.projects.map((p) => {
                  const tokens =
                    p.totals.input_tokens +
                    p.totals.output_tokens +
                    p.totals.cache_read_tokens +
                    p.totals.cache_write_tokens;
                  return (
                    <tr key={p.path} className={p.path === activePath ? "is-active" : ""}>
                      <td className="cell-name" title={p.path}>
                        {p.name}
                        <span className="cell-sub">{parentPath(p.path)}</span>
                      </td>
                      <td>{formatCount(p.totals.sessions)}</td>
                      <td>{formatCount(p.totals.messages)}</td>
                      <td>
                        <span className="bar-cell">
                          <span
                            className="bar"
                            style={{ width: `${maxProject ? (tokens / maxProject) * 100 : 0}%` }}
                          />
                          <span className="bar-label">{formatTokens(tokens)}</span>
                        </span>
                      </td>
                      <td className="muted-cell">
                        {relativeTime(p.last_used ? Date.parse(p.last_used) : undefined) || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <footer className="dialog-foot">
          <span className="muted">
            {data ? `${formatTokens(allTokens)} tokens across ${data.projects.length} projects` : ""}
          </span>
          <button className="primary-btn" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
