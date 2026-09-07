# Easy Switch

A desktop app that runs the real **Claude Code VS Code extension** UI, one
project at a time. Pick a project in the sidebar and its Claude Code session
fills the window — no VS Code chrome, no external editor.

Companion to the [Claude Code VS Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code).
Built with **Tauri 2 + React + TypeScript**.

## How it works

The Claude Code panel is a VS Code extension webview — it cannot run without an
extension host. So the app hosts one:

1. On launch it starts a single local `code serve-web` (VS Code for the Web,
   served from your installed VS Code). First run downloads the server component
   (~150 MB, handled by VS Code itself).
2. It installs `anthropic.claude-code` into the app's private extensions dir.
3. It drops in a tiny generated workspace extension, **easy-switch-layout**,
   which applies the layout for the current mode on every window (see below).
4. Each project is shown in a native **child webview** pointed at
   `http://127.0.0.1:<port>/?folder=<project>`.

Two implementation notes worth keeping:

- A **child webview, not an iframe** — `serve-web` sends
  `X-Frame-Options: SAMEORIGIN` and `frame-ancestors 'self'`, so framing is
  blocked; a top-level webview navigation is not.
- Layout settings are applied **through the extension API**, not by writing
  `settings.json`. VS Code for the Web keeps user settings in browser storage,
  so the server's user-data-dir is ignored. The helper also declares
  `untrustedWorkspaces.supported` so it can run in Restricted Mode long enough
  to turn workspace trust off.

The React layer is only the sidebar and window chrome; it tells Rust where to
place the VS Code webview and which project to show.

## Claude / Code modes

The header has a **Claude | Code** switch (`⌘E`):

- **Claude** — activity bar, status bar, tabs and breadcrumbs hidden; side bar,
  secondary side bar and panel closed; `claude-vscode.primaryEditor.open` gives
  Claude Code the whole editor area.
- **Code** — a normal editor: explorer, tabs, breadcrumbs and status bar back,
  with the secondary side bar and panel closed so Copilot's chat pane stays out
  of the way. Any open Claude tab stays open, so switching back is instant.

The mode is written to `easy-switch-mode.json` in the VS Code data dir *and*
pushed as a command, so live windows react immediately and windows opened later
come up in the same mode. VS Code settings are global, so the mode applies to
every project window rather than per project.

The helper writes a small rolling diagnostic log to `easy-switch-helper.log`
alongside it, which is what to read first if a layout ever fails to apply.

## Chats and usage

Both are read from Claude Code's own transcript store,
`~/.claude/projects/<slug>/<session>.jsonl`. The slug is a lossy encoding of the
project path, so the app matches projects by the `cwd` recorded inside each
transcript rather than trying to reverse it.

- **Chats column** — every past Claude Code chat for the selected project, newest
  first, with its AI-generated title, age, message count and model. Clicking one
  reopens that exact session; **+ New** starts a fresh one. Both work by asking
  the helper extension to run `claude-vscode.primaryEditor.open`, optionally with
  a session id.
- **Usage meters** — a rolling 5-hour block (anchored on its first turn, so its
  reset countdown is real) and a trailing 7-day total.

**A caveat on percentages.** The 5hr/weekly percentages Claude Code shows in
`/usage` come from Anthropic's API and are *not* stored on disk — transcripts
record `rateLimits: null`, and `quotaLimits` appears only on 429 rejections. So
these meters measure your own token consumption in those windows. Enter your
plan's token allowance under **Usage → Window limits** to turn them into
percentages; until then they show token counts. The weekly figure is labelled a
trailing window rather than given an invented reset instant, since the plan's
cycle is unknown.

Tokens counted for a window are input + output + cache writes; cache reads are
tracked separately because they dwarf everything else.

## Features

- **Manual project order** — the list is in the order you arrange it. Drag a row
  to sort (favourites and non-favourites reorder within their own group);
  selecting a project never moves it. Favouriting sends a project to the bottom
  of the favourites block; unfavouriting to the top of the rest. The drag is
  built on pointer events, not the HTML5 drag-and-drop API — WKWebView (the
  macOS webview) does not fire `dragover`/`drop` on plain elements.
- **Per-project colour and icon** — the `⋯` menu on each row sets an accent
  colour (used for the avatar always, and the whole row highlight when active)
  and uploads a custom icon. Icons are square-cropped and shrunk to 128px, then
  stored inline in `projects.json` — no loose files, no asset-protocol config.
- **Favourites** — star the projects you live in; they pin above the rest.
- **Import from VS Code** — one click pulls in folders VS Code already remembers
  (`storage.json`), filtered to ones that still exist.
- Reopens your last-used project on launch.
- **Three-pane split** — projects, chats and Claude Code. Drag the handles between
  panes to resize (double-click a handle to snap it back to its minimum); widths
  and collapsed state persist. Collapse either side pane with the two buttons in
  the header or `⌘1` / `⌘2`.
- **Claude / Code switch** — `⌘E`, or the segmented control in the header.
- **Global hotkey** — `⌘⇧O` (Ctrl+Shift+O) summons the window from anywhere.
- **Keyboard** — `↑`/`↓` move, `↵` open, `⌘D` favorite, `⌘⌫` remove, `⌘K` or `/`
  focus search, `⌘1` projects pane, `⌘2` chats pane, `⌘E` Claude/Code.

Dragging a split handle hides the embedded VS Code for the duration: it is a
native webview layered over the page, so it would otherwise swallow the pointer
as soon as the cursor crossed into it.

Tracked projects live in `projects.json` in the app config dir. Removing a
project never touches the folder.

## Develop

```bash
bun install
bun run tauri dev
```

Requires the Rust toolchain and Visual Studio Code at
`/Applications/Visual Studio Code.app` (or `code` on `PATH`).

## Build

```bash
bun run tauri build
```

## Known limits (v1)

- macOS-first; VS Code discovery covers macOS and Linux paths.
- Sign in to Claude from the extension as usual — OAuth opens your browser.
- One child webview per project path; `serve-web` restores each folder's state.
- Uses Tauri's `unstable` feature for multi-webview windows.
