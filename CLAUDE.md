# Working on the cockpit

Several Claude sessions may change the cockpit at the same time. `~/.claude/worktree-dashboard` is the shared checkout: it stays on `main` and runs the live instance. Never edit it directly.

- Work on a branch in its own git worktree: `git -C ~/.claude/worktree-dashboard worktree add -b feat/<slug> ~/.claude/worktree-dashboard-worktrees/<slug> main`, then edit only there.
- Test on a temporary port: symlink `token` and `cockpit.config.json` from the shared checkout (both git-ignored), then run `PORT=47xx HOST=127.0.0.1 node server.js`. Never restart the live instance yourself.
- Commit, push and merge into `main` only when the user asks. Merge from the shared checkout when its working tree is clean, then the user reloads with the "Recharger le cockpit" button.
- Remove the worktree once the branch is merged: `git -C ~/.claude/worktree-dashboard worktree remove ~/.claude/worktree-dashboard-worktrees/<slug>`.
