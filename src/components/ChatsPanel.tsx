import { useCallback, useEffect, useState } from "react";
import { api, type Project, type SessionSummary, type Totals } from "../lib/api";
import { formatTokens, relativeTime, shortModel } from "../lib/format";
import { PlusIcon, SearchIcon } from "./icons";

interface Props {
  width: number;
  firstPane: boolean;
  project: Project;
  serverReady: boolean;
  onShowUsage: () => void;
}

export function ChatsPanel({ width, firstPane, project, serverReady, onShowUsage }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .listSessions(project.path)
      .then((rows) => {
        setSessions(rows);
        setTotals(
          rows.reduce<Totals>(
            (acc, s) => ({
              sessions: acc.sessions + 1,
              messages: acc.messages + s.messages,
              input_tokens: acc.input_tokens + s.input_tokens,
              output_tokens: acc.output_tokens + s.output_tokens,
              cache_read_tokens: acc.cache_read_tokens + s.cache_read_tokens,
              cache_write_tokens: acc.cache_write_tokens + s.cache_write_tokens,
            }),
            {
              sessions: 0,
              messages: 0,
              input_tokens: 0,
              output_tokens: 0,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
            },
          ),
        );
      })
      .catch(() => setSessions([]));
  }, [project.path]);

  useEffect(() => {
    setSessions(null);
    setActiveId(null);
    setQuery("");
    load();
  }, [load]);

  // Transcripts are written as the conversation goes; keep the list fresh.
  useEffect(() => {
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  async function newChat() {
    if (!serverReady) return;
    setBusy(true);
    setActiveId(null);
    try {
      await api.newChat();
      setTimeout(load, 4000);
    } finally {
      setTimeout(() => setBusy(false), 800);
    }
  }

  async function openSession(s: SessionSummary) {
    if (!serverReady) return;
    setActiveId(s.id);
    setBusy(true);
    try {
      await api.openSession(s.id);
    } finally {
      setTimeout(() => setBusy(false), 800);
    }
  }

  const filtered = (sessions ?? []).filter((s) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      s.title.toLowerCase().includes(q) ||
      s.last_prompt.toLowerCase().includes(q) ||
      (s.git_branch ?? "").toLowerCase().includes(q)
    );
  });

  const totalTokens = totals
    ? totals.input_tokens + totals.output_tokens + totals.cache_read_tokens + totals.cache_write_tokens
    : 0;

  return (
    <section className="chats" style={{ width }}>
      <header
        className={"pane-top chats-head" + (firstPane ? " with-traffic" : "")}
        data-tauri-drag-region
      >
        <h2>Chats</h2>
        <button className="new-chat" onClick={newChat} disabled={!serverReady || busy}>
          <PlusIcon /> New
        </button>
      </header>

      {(sessions?.length ?? 0) > 6 && (
        <div className="chats-filter">
          <SearchIcon className="search-icon" />
          <input
            className="search"
            placeholder="Filter chats…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      <div className="chats-list">
        {sessions === null && <p className="chats-note">Reading history…</p>}
        {sessions !== null && sessions.length === 0 && (
          <p className="chats-note">
            No Claude Code chats recorded for this project yet. Start one with <b>+ New</b>.
          </p>
        )}
        {sessions !== null && sessions.length > 0 && filtered.length === 0 && (
          <p className="chats-note">No chats match “{query}”.</p>
        )}

        {filtered.map((s) => (
          <button
            key={s.id}
            className={"chat-row" + (s.id === activeId ? " active" : "")}
            onClick={() => openSession(s)}
            title={s.last_prompt || s.title}
          >
            <span className="chat-title">{s.title}</span>
            <span className="chat-meta">
              <span>{relativeTime(s.updated ? Date.parse(s.updated) : undefined)}</span>
              <span className="dotsep">·</span>
              <span>{s.messages} msgs</span>
              {s.models[0] && (
                <>
                  <span className="dotsep">·</span>
                  <span className="chat-model">{shortModel(s.models[0])}</span>
                </>
              )}
            </span>
          </button>
        ))}
      </div>

      <footer className="chats-foot">
        <button className="usage-strip" onClick={onShowUsage} title="Usage across all projects">
          <span>
            {totals?.sessions ?? 0} chat{(totals?.sessions ?? 0) === 1 ? "" : "s"}
          </span>
          <span className="dotsep">·</span>
          <span>{formatTokens(totalTokens)} tokens</span>
          <span className="usage-more">Usage →</span>
        </button>
      </footer>
    </section>
  );
}
