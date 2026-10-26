---
name: run-app
description: Start, restart, stop or check the project's local app from any Claude session, worktrees included. The app runs once at the root of the main checkout, driven by the worktree cockpit. Use when asked to run, launch, restart or stop the app, or whether it is up.
---

# Run the app

The app runs **once**, at the root of the main checkout (the cockpit's `repo`), inside the tmux
session `cw-app` owned by the worktree cockpit (`~/.claude/worktree-dashboard`), with the command
set in its `cockpit.config.json` (`app.command`). This is the sanctioned way to start it from a
worktree session: never start the app from a worktree directory yourself.

The app serves the branch checked out in the main checkout, not the worktree's branch. Tell the
user which branch that is before saying "the app is up with your change". Never switch that branch
yourself: ask the user.

## API

The cockpit listens on `127.0.0.1:8052` (inside the container when one is configured). Every API
call needs the access token in `X-Cockpit-Token`; write calls also need `X-Cockpit: 1`. Read the
token from its file in each command, never print it or paste it into a message.

| Action | Command |
|---|---|
| State | `curl -s -H "X-Cockpit-Token: $(cat ~/.claude/worktree-dashboard/token)" http://127.0.0.1:8052/api/app` |
| Start | `curl -s -X POST -H 'X-Cockpit: 1' -H "X-Cockpit-Token: $(cat ~/.claude/worktree-dashboard/token)" http://127.0.0.1:8052/api/app/start` |
| Restart | `curl -s -X POST -H 'X-Cockpit: 1' -H "X-Cockpit-Token: $(cat ~/.claude/worktree-dashboard/token)" -d '{"restart":true}' http://127.0.0.1:8052/api/app/start` |
| Stop | `curl -s -X POST -H 'X-Cockpit: 1' -H "X-Cockpit-Token: $(cat ~/.claude/worktree-dashboard/token)" http://127.0.0.1:8052/api/app/stop` |
| Build log | `curl -s -H "X-Cockpit-Token: $(cat ~/.claude/worktree-dashboard/token)" 'http://127.0.0.1:8052/api/screen?target=app'` |

`/api/app` returns `null` when no app is configured: say so and stop.

If the cockpit does not answer, run `~/.claude/worktree-dashboard/ensure.sh` and retry once; if it
still does not answer, ask the user to run `~/.claude/worktree-dashboard/start.sh`.

## States

`state` in `/api/app`:

| State | Meaning |
|---|---|
| `stopped` | no launch session, no process and the health URL does not answer |
| `building` | the launch command runs in `cw-app`; `build.lastLine` is its last output line |
| `starting` | launch done, processes online, the health URL not answering yet (or 503) |
| `up` | the app answers and no process has a problem |
| `degraded` | the app answers, but `warnings` lists stopped or crash-looping processes |
| `ko` | the launch command exited non-zero, or the app does not answer while processes fail; `reason` says which |

With `usesPm2`, one-shot processes that stopped with exit code 0 are finished, not failed, and a
process `online` with 3+ restarts and less than 15 s of uptime is crash-looping.

Start refuses with a 409 while a launch runs, or when the app is already up (use restart).
With `usesPm2`, restart and stop run `pm2 delete all`: ask the user first if someone else may be
using the app.

## Waiting

A full build can take several minutes. Do not poll with a sleep loop: use `Monitor` with an
until-condition on `/api/app` reaching `up` or `ko`, capped around 15 minutes.

## When it is `ko`

1. Read `reason`, then the build log (`/api/screen?target=app`) or, with `usesPm2`,
   `pm2 logs <name> --lines 100 --nostream` from the main checkout.
2. If `recoveryDoc` is set, read that file (relative to the main checkout) and follow it before
   restarting anything.
3. Report the cause and the last log lines to the user. Restart at most twice, then stop and hand over.

The user can follow and drive the same thing from the cockpit side panel: the app button shows the
state and opens the build log.
