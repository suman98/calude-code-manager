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
   which on every window: applies the chrome-free settings, closes the side bar,
   secondary side bar and panel, and runs
   `claude-vscode.primaryEditor.open` so Claude Code owns the whole editor area.
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
- **Usage meters** — rolling 5-hour and 7-day windows, anchored on the first turn
  inside each window, with real reset countdowns.

**A caveat on percentages.** The 5hr/weekly percentages Claude Code shows in
`/usage` come from Anthropic's API and are *not* stored on disk — transcripts
record `rateLimits: null`, and `quotaLimits` appears only on 429 rejections. So
these meters measure your own token consumption in those windows. Enter your
plan's token allowance under **Usage → Window limits** to turn them into
percentages; until then they show token counts and window progress.

Tokens counted for a window are input + output + cache writes; cache reads are
tracked separately because they dwarf everything else.

## Features

- **Recents + favorites** — every project you open is tracked, most-recent
  first; star the ones you live in. Reopens your last project on launch.
- **Import from VS Code** — one click pulls in folders VS Code already remembers
  (`storage.json`), filtered to ones that still exist.
- **Global hotkey** — `⌘⇧O` (Ctrl+Shift+O) summons the window from anywhere.
- **Keyboard** — `↑`/`↓` move, `↵` open, `⌘D` favorite, `⌘⌫` remove, `⌘K` or `/`
  focus search.

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
