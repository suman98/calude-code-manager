import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, pickFolder, type Project, type ServerStatus, type VscodeMode } from "./lib/api";
import { Sidebar, flatList } from "./components/Sidebar";
import { VscodeView } from "./components/VscodeView";
import { ImportDialog } from "./components/ImportDialog";
import { ChatsPanel } from "./components/ChatsPanel";
import { UsageDialog } from "./components/UsageDialog";
import { Resizer } from "./components/Resizer";
import "./App.css";

const INITIAL_STATUS: ServerStatus = { phase: "starting", message: "Starting…", port: null };

const PROJECTS_MIN = 210;
const CHATS_MIN = 220;
const PANE_MIN = 380;

function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function remember(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private window, non-fatal */
  }
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [status, setStatus] = useState<ServerStatus>(INITIAL_STATUS);
  const [showImport, setShowImport] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [showProjects, setShowProjects] = useState(() => stored("es.showProjects", true));
  const [showChats, setShowChats] = useState(() => stored("es.showChats", true));
  const [projectsWidth, setProjectsWidth] = useState(() => stored("es.projectsWidth", 290));
  const [chatsWidth, setChatsWidth] = useState(() => stored("es.chatsWidth", 268));
  const [resizing, setResizing] = useState(false);
  const [mode, setMode] = useState<VscodeMode>("claude");

  useEffect(() => remember("es.showProjects", showProjects), [showProjects]);
  useEffect(() => remember("es.showChats", showChats), [showChats]);
  useEffect(() => remember("es.projectsWidth", projectsWidth), [projectsWidth]);
  useEffect(() => remember("es.chatsWidth", chatsWidth), [chatsWidth]);

  const searchRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  const flat = useMemo(() => flatList(projects, query), [projects, query]);
  const activeProject = useMemo(
    () => projects.find((p) => p.path === activeId) ?? null,
    [projects, activeId],
  );

  useEffect(() => {
    api
      .list()
      .then(setProjects)
      .catch((e) => setError(String(e)))
      .finally(() => setLoaded(true));
  }, []);

  // VS Code server lifecycle.
  useEffect(() => {
    let alive = true;
    void api.ensureServer();
    api.serverStatus().then((s) => alive && setStatus(s)).catch(() => {});
    const un = listen<ServerStatus>("vscode:status", (e) => alive && setStatus(e.payload));
    const poll = setInterval(() => {
      api.serverStatus().then((s) => alive && setStatus(s)).catch(() => {});
    }, 2000);
    return () => {
      alive = false;
      clearInterval(poll);
      void un.then((f) => f()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    setSelectedIndex((s) => Math.min(s, Math.max(0, flat.length - 1)));
  }, [flat.length]);

  useEffect(() => {
    rowRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const flash = useCallback((msg: string) => {
    setError(msg);
    window.setTimeout(() => setError((e) => (e === msg ? null : e)), 4500);
  }, []);

  const selectProject = useCallback(
    (p: Project) => {
      setActiveId(p.path);
      setOpenIds((ids) => (ids.includes(p.path) ? ids : [...ids, p.path]));
      api.touch(p.path).then(setProjects).catch((e) => flash(String(e)));
    },
    [flash],
  );

  // On first ready, reopen the most recently used project.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current || status.phase !== "ready" || !loaded || activeId) return;
    const last = [...projects]
      .filter((p) => p.last_opened)
      .sort((a, b) => (b.last_opened ?? 0) - (a.last_opened ?? 0))[0];
    if (last) {
      resumedRef.current = true;
      selectProject(last);
    }
  }, [status.phase, loaded, projects, activeId, selectProject]);

  const toggleFavorite = useCallback(async (p: Project) => {
    try {
      setProjects(await api.toggleFavorite(p.path));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const removeProject = useCallback(async (p: Project) => {
    if (!confirm(`Remove “${p.name}” from Easy Switch?\nThe folder is not deleted.`)) return;
    try {
      await api.closeVscode(p.path).catch(() => {});
      setOpenIds((ids) => ids.filter((id) => id !== p.path));
      setActiveId((cur) => (cur === p.path ? null : cur));
      setProjects(await api.remove(p.path));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const addFolder = useCallback(async () => {
    const dir = await pickFolder();
    if (!dir) return;
    try {
      const next = await api.add(dir);
      setProjects(next);
      setQuery("");
      const norm = dir.replace(/\/+$/, "");
      const added = next.find((p) => p.path === dir || p.path === norm);
      if (added) selectProject(added);
    } catch (e) {
      flash(String(e));
    }
  }, [flash, selectProject]);

  // The mode lives in the VS Code data dir so new windows come up matching.
  useEffect(() => {
    api.getMode().then(setMode).catch(() => {});
  }, []);

  const changeMode = useCallback((next: VscodeMode) => {
    setMode(next);
    api.setMode(next).catch(() => {});
  }, []);

  const retryServer = useCallback(() => {
    setStatus({ phase: "starting", message: "Starting…", port: null });
    void api.ensureServer();
  }, []);

  // Global keyboard — sidebar navigation. When focus is in the embedded VS Code
  // iframe, the browser hands keys straight to it, so this never interferes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (showImport || showUsage) return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (!showProjects) setShowProjects(true);
        setTimeout(() => {
          searchRef.current?.focus();
          searchRef.current?.select();
        }, 0);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "1") {
        e.preventDefault();
        setShowProjects((v) => !v);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "2") {
        e.preventDefault();
        setShowChats((v) => !v);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e") {
        e.preventDefault();
        changeMode(mode === "claude" ? "code" : "claude");
        return;
      }

      const inSearch = document.activeElement === searchRef.current;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((s) => Math.min(s + 1, flat.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((s) => Math.max(s - 1, 0));
      } else if (e.key === "Enter" && (inSearch || document.activeElement === document.body)) {
        if (flat[selectedIndex]) selectProject(flat[selectedIndex]);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        if (flat[selectedIndex]) void toggleFavorite(flat[selectedIndex]);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Backspace") {
        e.preventDefault();
        if (flat[selectedIndex]) void removeProject(flat[selectedIndex]);
      } else if (e.key === "Escape") {
        if (query) setQuery("");
      } else if (!inSearch && e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showImport, showUsage, showProjects, mode, changeMode, flat, selectedIndex, query, selectProject, toggleFavorite, removeProject]);

  const chatsVisible = showChats && !!activeProject;
  const maxProjects = Math.max(PROJECTS_MIN, window.innerWidth - PANE_MIN - (chatsVisible ? chatsWidth : 0));
  const maxChats = Math.max(CHATS_MIN, window.innerWidth - PANE_MIN - (showProjects ? projectsWidth : 0));

  // Whichever pane sits leftmost has to clear the macOS traffic lights.
  const firstPane = showProjects ? "projects" : chatsVisible ? "chats" : "main";

  return (
    <div className="app">
      {showProjects && (
        <>
          <Sidebar
            width={projectsWidth}
            firstPane={firstPane === "projects"}
            projects={projects}
            activeId={activeId}
            openIds={new Set(openIds)}
            query={query}
            selectedIndex={selectedIndex}
            onQuery={(q) => {
              setQuery(q);
              setSelectedIndex(0);
            }}
            onSelect={selectProject}
            onToggleFavorite={toggleFavorite}
            onRemove={removeProject}
            onAdd={addFolder}
            onImport={() => setShowImport(true)}
            onShowUsage={() => setShowUsage(true)}
            searchRef={searchRef}
            rowRefs={rowRefs}
          />
          <Resizer
            label="Resize projects"
            width={projectsWidth}
            min={PROJECTS_MIN}
            max={maxProjects}
            onResize={setProjectsWidth}
            onDragStart={() => setResizing(true)}
            onDragEnd={() => setResizing(false)}
          />
        </>
      )}

      {chatsVisible && activeProject && (
        <>
          <ChatsPanel
            key={activeProject.path}
            width={chatsWidth}
            firstPane={firstPane === "chats"}
            project={activeProject}
            serverReady={status.phase === "ready"}
            onShowUsage={() => setShowUsage(true)}
          />
          <Resizer
            label="Resize chats"
            width={chatsWidth}
            min={CHATS_MIN}
            max={maxChats}
            onResize={setChatsWidth}
            onDragStart={() => setResizing(true)}
            onDragEnd={() => setResizing(false)}
          />
        </>
      )}

      <main className="main">
        {error && <div className="notice error">{error}</div>}
        {loaded && projects.length === 0 && !activeProject && status.phase === "ready" ? (
          <Welcome onAdd={addFolder} onImport={() => setShowImport(true)} />
        ) : (
          <VscodeView
            project={activeProject}
            status={status}
            suppressed={showImport || showUsage || resizing}
            firstPane={firstPane === "main"}
            showProjects={showProjects}
            showChats={showChats}
            mode={mode}
            onMode={changeMode}
            onToggleProjects={() => setShowProjects((v) => !v)}
            onToggleChats={() => setShowChats((v) => !v)}
            onRetry={retryServer}
          />
        )}
      </main>

      {showImport && (
        <ImportDialog onClose={() => setShowImport(false)} onImported={(next) => setProjects(next)} />
      )}
      {showUsage && <UsageDialog activePath={activeId} onClose={() => setShowUsage(false)} />}
    </div>
  );
}

function Welcome({ onAdd, onImport }: { onAdd: () => void; onImport: () => void }) {
  return (
    <div className="welcome">
      <div className="welcome-glyph">⇄</div>
      <h1>Claude Code, one project away</h1>
      <p>
        Add your project folders. Click one and it opens right here in VS Code with the Claude Code
        panel — switch projects any time, each keeps its place.
      </p>
      <div className="row-gap">
        <button className="ghost-btn" onClick={onImport}>
          Import from VS Code
        </button>
        <button className="primary-btn" onClick={onAdd}>
          Add folder
        </button>
      </div>
      <p className="hint">
        <kbd>⌘</kbd>
        <kbd>⇧</kbd>
        <kbd>O</kbd> summons this window · <kbd>⌘</kbd>
        <kbd>K</kbd> jumps to search
      </p>
    </div>
  );
}
