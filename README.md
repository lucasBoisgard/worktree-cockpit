# worktree-cockpit

> **Warning.** The cockpit gives whoever holds its access token a shell on the machine it runs on, and lets them drive your Claude Code sessions. Keep its port on a network you trust, never share the URL printed by `start.sh`, and read [Security](#security) before exposing it.

A small web cockpit to follow and drive parallel Claude Code sessions started with `claude --worktree`.

For each git worktree it shows the Claude session state (working / needs input / done), the conversation, the live terminal, the changed files and their diff. Sessions running in tmux can be driven from the browser: send messages, answer permission prompts, switch permission mode, start or resume a session, close a worktree. A persistent bash terminal is available as its own card.

When an app is configured, every side panel also carries an app button and an App tab: they run the app's launch command once at the root of the main checkout (tmux session `cw-app`) and show its state — stopped, building, starting, up, degraded or KO — with the launch log, restart and stop.

No npm dependency: Node, git and tmux only.

## Install

1. Clone into `~/.claude/worktree-dashboard`.
2. Copy `cockpit.config.example.json` to `cockpit.config.json` and fill it in (optional, see below).
3. Run `~/.claude/worktree-dashboard/start.sh`. Through `install.js` it merges the missing `settings.snippet.json` entries into `~/.claude/settings.json` (backup `settings.json.bak-cockpit-<timestamp>`, existing hooks and an existing `statusLine` are kept), links `skills/*` into `~/.claude/skills/` and generates the access token. It is idempotent and runs on every start; later starts are automatic through the `SessionStart` hook.
4. Claude Code loads hooks when a session starts, so sessions already open do not report to the cockpit: quit each one (`/exit`) and reopen it with `claude --resume`. New sessions need nothing.
5. Open the URL printed by `start.sh` (`http://<host>:8052/?token=…`).

## Configuration

`cockpit.config.json` is git-ignored. Every key is optional; `${VAR}` in a value is replaced by that environment variable.

| Key | Default | Role |
| --- | --- | --- |
| `repo` | main checkout of the current directory | Repository whose worktrees are shown |
| `container` | none | Docker container to run in: `start.sh` re-runs itself there with `docker exec` |
| `hosts` | `[]` | Extra hostnames allowed in the `Host` header |
| `claudeBin` | `~/.local/bin/claude` | Claude Code binary used for sessions started from the cockpit |
| `app.command` | none (no app button) | Launch command, run in the main checkout |
| `app.processManager` | none | `pm2` to read process states and run `pm2 delete all` before a restart and on stop |
| `app.pm2Bin` | `node_modules/.bin/pm2` of the repo, else `pm2` | pm2 binary |
| `app.healthUrl` | none | URL polled to tell starting from up (a 503 counts as not answering) |
| `app.url` | `app.healthUrl` | "Open the app" link |
| `app.recoveryDoc` | none | Troubleshooting doc, relative to the repo, shown on KO and read by the `run-app` skill |

Environment variables: `PORT` (default 8052 through `start.sh`), `HOST` or `COCKPIT_LISTEN` (default `0.0.0.0` inside a container, `127.0.0.1` elsewhere), `MACHINE_HOSTNAME` (allowed host and printed URL), `COCKPIT_HOSTS` (comma-separated extra hosts), `REPO` and `CLAUDE_BIN` (override the config).

## Layout

| File | Role |
| --- | --- |
| `server.js` | HTTP server: state, transcripts, diffs, tmux driving, worktree close, app launch |
| `index.html` | The whole UI (HTML, CSS, JS) |
| `start.sh` | Runs the install, installs tmux if missing and (re)starts the server |
| `install.js` | Idempotent install: hooks and status line in `~/.claude/settings.json`, skill links, access token |
| `ensure.sh` | `SessionStart` hook: starts the server when it is not running |
| `cockpit.config.example.json` | Configuration template |
| `hooks/worktree-state.js` | Claude Code hook writing one JSON state file per session in `~/.claude/worktree-state/` |
| `statusline.js` | Claude Code status line: worktree, branch, dirty files, unpushed commits |
| `skills/run-app/SKILL.md` | Claude Code skill: start, stop and check the app from any session through the cockpit API |
| `settings.snippet.json` | The `statusLine` and `hooks` entries merged by `install.js` |

## Security

- Access token: `install.js` generates a 256-bit random token in `token` (mode 600, git-ignored). The page stores it in its own `localStorage` (not a cookie, which other apps on the same host would receive), removes it from the URL and sends it as `X-Cockpit-Token` on every API call. It is compared in constant time. Rotate it with `rm ~/.claude/worktree-dashboard/token && ~/.claude/worktree-dashboard/start.sh`.
- Host allowlist: every request, the page included, is refused with a 421 unless its `Host` is `localhost`, `127.0.0.1`, `$MACHINE_HOSTNAME` or listed in `hosts` / `COCKPIT_HOSTS`. This blocks DNS rebinding.
- Write routes also require a `POST` with the `X-Cockpit: 1` header and a same-origin `Origin`.
- Outside a container the server listens on `127.0.0.1` only.

## Notes

- Only sessions running in tmux can be driven; others are read-only.
- `index.html` and `server.js` are read at startup: rerun `start.sh` after editing them.
- Claude Code auto mode refuses edits to `~/.claude/settings.json` and to the tmux driving code: switch to the default permission mode first.
