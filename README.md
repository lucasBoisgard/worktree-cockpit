# worktree-cockpit

> **Warning.** The cockpit gives whoever holds its access token a shell on the machine it runs on, and lets them drive your Claude Code sessions. Keep its port on a network you trust, never share the URL printed by `start.sh`, and read [Security](#security) before exposing it.

A small web cockpit to follow and drive parallel Claude Code sessions started with `claude --worktree`.

For each git worktree it shows the Claude session state (working / needs input / done), the conversation, the live terminal, the changed files and their diff. Sessions running in tmux can be driven from the browser: send messages, answer permission prompts, switch permission mode, start or resume a session, close a worktree. A persistent bash terminal is available as its own card.

"New session" can start a **review** session instead of a free one: give it a pull request, and the session starts with a system prompt that lists the review skills to load (`code-review`, `security-review` and every skill whose name contains "review", or `review.skills` in the config) and asks for a report through the `review-report` skill. The report (`~/.claude/worktree-reviews/<worktree>.report.json`) is shown in a "Rapport" tab as colored blocks: blocking (red, request changes), to fix (amber), suggestion (blue), question (violet), praise (green), context (grey), each with its finding, impact, fix and a draft PR comment to copy.

When an app is configured, every side panel also carries an app button and an App tab: they run the app's launch command once at the root of the main checkout (tmux session `cw-app`) and show its state — stopped, building, starting, up, degraded or KO — with the launch log, restart and stop.

A "Tokens utilisés" card shows how much of the account's usage limits is used (5-hour and 7-day windows, spend limit when there is one) with their reset time. It turns amber at 80 % used and red at 95 %, and the header then shows the limit as an alert. Worktree cards show a "Contexte" chip when 20 % or less of their session's context window is left. The card opens a Tokens tab with the used and remaining share of each limit, each session's remaining context and estimated cost, the tokens processed per day over 7 days and the usage per worktree. Limits, context and cost come from what Claude Code sends to the status line: `statusline.js` writes one snapshot per session in `~/.claude/worktree-usage/`, so the limits shown are those of the last Claude answer. The daily history is read from the transcripts in `~/.claude/projects/` (subagents included).

### Attention and triage

- **Notifications.** A background loop (every 3 s, even with no page open) turns session transitions into events: permission asked, question asked, turn done, CI failing, PR merged, app KO, automation run. They show as toasts (click to open the session), in the bell inbox (filters, mark as read) and as an OS notification when the page is hidden and served over HTTPS. The tab title carries the number of sessions waiting for you and the favicon turns amber. With `notify.ntfyUrl` set, events are also posted to an ntfy topic for phone push.
- **Peek and quick reply.** A card shows Claude's last message (click to unfold), a short reply field, and for a pending permission or `AskUserQuestion` the matching buttons (they send the option number to the session).
- **Grouping and pins.** "Par état" groups worktrees into pinned, waiting for you, ready to review, working and others, sorted by last activity. ☆ pins a card on top in both orders.
- **Keyboard.** `Ctrl K` opens a command palette; `j`/`k` move between cards, `Enter` opens, `Space` unfolds, `a` allows the pending permission, `1`-`6` switch tabs, `n` new session, `h` history, `i` notifications, `?` help.

### Steering several sessions

- **Message queue.** While Claude works, the composer becomes "Mettre en file": queued messages leave when the turn ends.
- **Broadcast.** "Outils → Écrire à plusieurs sessions" selects cards and sends one message to all of them (busy ones get it queued).
- **Variants.** "Nouvelle session" can start N worktrees with the same prompt to compare approaches.
- **Delegation.** "Déléguer" on a Claude message starts a linked session pre-filled with that context. Cards show the parent and child links, and the parent can be told when the child finishes a turn.
- **Automations.** "Outils → Automatisations" starts a session with a prompt every day at a set time or every N minutes, in a fixed worktree or a new dated one.

### Review and delivery

- **Diff comments.** In "Changements", `+` on a line adds a comment; "Envoyer à Claude" sends all pending comments as one structured message. Report blocks have "Faire corriger par Claude" and "Voir dans le diff".
- **Checkpoints.** The hook records a git snapshot (`git stash create`, no commit, no index change) at every prompt. "Changements" can compare with the state before any turn, the conversation links each message to its changes, and "Restaurer ce point" checks the tracked files out as they were.
- **PR and CI.** With `gh` logged in, each card shows its PR (number, draft, CI running or failing, changes requested, ready, merged), refreshed every minute. A PR tab lists checks, reviews and a "ready to merge" banner, and sends a failing check's log to Claude. "Pousser et ouvrir la PR" pushes the existing commits (no add, no commit) and opens the PR from a template with the configured labels and assignee, then checks them and the absence of a generated footer.
- **Archive and cleanup.** "Archiver" stops the sessions and removes the worktree but keeps its branch and conversation; archived worktrees can be restored, with their session resumed. "Outils → Nettoyage" lists every worktree with its idle time, disk size and git state, for bulk archive or close (close only for merged branches).
- **Serve the app from a worktree.** "Servir l'app" checks the main checkout out on the worktree's last commit (detached HEAD) and restarts the app; "Revenir au checkout principal" puts it back. Refused when the main checkout has uncommitted changes.
- **History.** "Outils → Historique" lists and searches every past session of the repo (messages and edited files), opens it read-only, resumes it in tmux (recreating its worktree from the branch if needed) or starts a new session with its context.

No npm dependency: Node, git and tmux only (`gh` for the PR features).

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
| `review.skills` | `code-review`, `security-review` and the skills named `*review*` | Skills a review session is told to load |
| `app.command` | none (no app button) | Launch command, run in the main checkout |
| `app.processManager` | none | `pm2` to read process states and run `pm2 delete all` before a restart and on stop |
| `app.pm2Bin` | `node_modules/.bin/pm2` of the repo, else `pm2` | pm2 binary |
| `app.healthUrl` | none | URL polled to tell starting from up (a 503 counts as not answering) |
| `app.url` | `app.healthUrl` | "Open the app" link |
| `app.recoveryDoc` | none | Troubleshooting doc, relative to the repo, shown on KO and read by the `run-app` skill |
| `pr.base` | `master` | Base branch for PRs, merged checks and cleanup |
| `pr.labels` | `[]` | Labels pre-filled in "Pousser et ouvrir la PR" |
| `pr.assignee` | none | Assignee pre-filled in "Pousser et ouvrir la PR" |
| `pr.template` | TL;DR / Ticket / Points d'attention / Comment tester | PR body template; `{ticket}` is replaced by the ticket id found in the branch name |
| `notify.ntfyUrl` | none | ntfy topic URL that receives events (sent outside your network: use a private topic) |
| `notify.types` | `needs_input`, `permission`, `question`, `ci_failed`, `app_ko` | Event types posted to ntfy |

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
| `statusline.js` | Claude Code status line: worktree, branch, dirty files, unpushed commits; also writes the session's usage snapshot to `~/.claude/worktree-usage/` |
| `skills/run-app/SKILL.md` | Claude Code skill: start, stop and check the app from any session through the cockpit API |
| `skills/review-report/SKILL.md` | Claude Code skill: the JSON format of a review report rendered by the cockpit |
| `settings.snippet.json` | The `statusLine` and `hooks` entries merged by `install.js` |

## Security

- Access token: `install.js` generates a 256-bit random token in `token` (mode 600, git-ignored). The page stores it in its own `localStorage` (not a cookie, which other apps on the same host would receive), removes it from the URL and sends it as `X-Cockpit-Token` on every API call. It is compared in constant time. Rotate it with `rm ~/.claude/worktree-dashboard/token && ~/.claude/worktree-dashboard/start.sh`.
- Host allowlist: every request, the page included, is refused with a 421 unless its `Host` is `localhost`, `127.0.0.1`, `$MACHINE_HOSTNAME` or listed in `hosts` / `COCKPIT_HOSTS`. This blocks DNS rebinding.
- Write routes also require a `POST` with the `X-Cockpit: 1` header and a same-origin `Origin`.
- Outside a container the server listens on `127.0.0.1` only.

## Notes

- Only sessions running in tmux can be driven; others are read-only. "Reprendre dans le cockpit" reopens a read-only session in tmux with `claude --resume`.
- A session counts as running in tmux when its state file names a live pane, or when Claude Code's own registry (`~/.claude/sessions/<pid>.json`) maps it to a live pane and its process is alive. The second check keeps a session drivable after the same conversation was resumed in another terminal.
- Sessions with no message (no transcript) are hidden unless they are running, and so are sessions whose worktree directory was removed.
- `index.html` and `server.js` are read at startup: after editing them, click "Recharger le cockpit" (it reruns `start.sh`) or rerun `start.sh`.
- The server keeps its own data in `~/.claude`: `worktree-events.json` (notifications), `worktree-queue.json` (queued messages), `worktree-links.json` (delegations), `worktree-archive.json`, `worktree-automations.json`, `worktree-app-serve.json` (app served from a worktree) and `worktree-state/<session>.checkpoints.json`.
- Only one server should run its background loop at a time: a test instance started with `COCKPIT_NO_TICK=1` does not send queued messages, run automations or record events.

## Uninstall

1. Remove the cockpit entries from `~/.claude/settings.json` (the `statusLine` and the hooks pointing to this directory), or restore the `settings.json.bak-cockpit-*` backup written by the install.
2. Remove the skill links: `rm ~/.claude/skills/run-app ~/.claude/skills/review-report`.
3. Stop the server (`kill "$(cat ~/.claude/worktree-dashboard/server.pid)"`) and delete `~/.claude/worktree-dashboard`. `~/.claude/worktree-state/`, `~/.claude/worktree-reviews/`, `~/.claude/worktree-usage/` and the `~/.claude/worktree-*.json` data files can be deleted too.
- Claude Code auto mode refuses edits to `~/.claude/settings.json` and to the tmux driving code: switch to the default permission mode first.
