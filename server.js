#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');

function expandEnv(value) {
  if (typeof value === 'string') return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '');
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v)]));
  return value;
}

function loadConfig() {
  const file = path.join(__dirname, 'cockpit.config.json');
  if (!fs.existsSync(file)) return {};
  return expandEnv(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function detectRepo() {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return path.dirname(common);
  } catch {
    return process.cwd();
  }
}

const CONFIG = loadConfig();
const STARTED_AT = Date.now();
const PORT = Number(process.env.PORT || 4747);
const HOST = process.env.HOST || '127.0.0.1';
const REPO = process.env.REPO || CONFIG.repo || detectRepo();
const CLAUDE_BIN = process.env.CLAUDE_BIN || CONFIG.claudeBin || path.join(os.homedir(), '.local', 'bin', 'claude');
const STATE_DIR = path.join(os.homedir(), '.claude', 'worktree-state');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CLAUDE_SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const REVIEWS_DIR = path.join(os.homedir(), '.claude', 'worktree-reviews');
const USAGE_DIR = path.join(os.homedir(), '.claude', 'worktree-usage');
const USAGE_DAYS = 7;
const USAGE_SESSIONS_MAX = 30;
const HISTORY_CACHE_TTL_MS = 30000;
const DATA_DIR = path.join(os.homedir(), '.claude');
const BASE_BRANCH = CONFIG.pr?.base || CONFIG.baseBranch || 'master';
const TICK_MS = 3000;
const TICK_ENABLED = process.env.COCKPIT_NO_TICK !== '1';
const PR_REFRESH_MS = 60000;
const EVENTS_MAX = 200;
const HISTORY_FILES_MAX = 400;
const SIZE_TTL_MS = 10 * 60 * 1000;
const SHELL_SESSION = 'cw-shell';
const APP_SESSION = 'cw-app';
const APP = CONFIG.app?.command ? CONFIG.app : null;
const USE_PM2 = APP?.processManager === 'pm2';
const PM2_BIN = APP?.pm2Bin || (fs.existsSync(path.join(REPO, 'node_modules', '.bin', 'pm2')) ? path.join(REPO, 'node_modules', '.bin', 'pm2') : 'pm2');
const PM2_PID_FILE = path.join(os.homedir(), '.pm2', 'pm2.pid');
const CRASH_LOOP_UPTIME_MS = 15000;
const TOKEN_FILE = path.join(__dirname, 'token');
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', process.env.MACHINE_HOSTNAME, ...(CONFIG.hosts || []), ...(process.env.COCKPIT_HOSTS || '').split(',')].map((h) => (h || '').trim().toLowerCase()).filter(Boolean));
const TMUX_SIZE = ['-x', '200', '-y', '50'];
const TMUX_PATH = `PATH=${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}:${path.dirname(CLAUDE_BIN)}`;
const CACHE_TTL_MS = 2500;
const SESSION_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const CHAT_MAX_ITEMS = 400;
const TOOL_RESULT_MAX_CHARS = 3000;
const SCREEN_HISTORY_LINES = 500;
const BODY_MAX_BYTES = 1024 * 1024;
const NAMED_KEYS = new Set(['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Tab', 'BTab', 'BSpace', 'DC', 'Home', 'End', 'PPage', 'NPage', 'C-a', 'C-c', 'C-d', 'C-e', 'C-k', 'C-l', 'C-o', 'C-r', 'C-u', 'C-w', 'C-z']);

function run(cmd, args, input) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ ok: !error, stdout: stdout || '', stderr: stderr || (error ? error.message : '') }),
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmux = (args, input) => run('tmux', args, input);

async function git(cwd, args) {
  const result = await run('git', ['-C', cwd, ...args]);
  return result.ok ? result.stdout : null;
}

async function listWorktrees() {
  const out = (await git(REPO, ['worktree', 'list', '--porcelain'])) || '';
  return out
    .split('\n\n')
    .map((block) => {
      const wt = {};
      for (const line of block.split('\n')) {
        const [key, ...rest] = line.split(' ');
        const value = rest.join(' ');
        if (key === 'worktree') wt.path = value;
        if (key === 'branch') wt.branch = value.replace('refs/heads/', '');
        if (key === 'HEAD') wt.head = value;
        if (key === 'detached') wt.detached = true;
        if (key === 'locked') {
          const claude = value.match(/^claude session .* \(pid (\d+) start (\d+)\)$/);
          if (claude) wt.claudeLock = { pid: Number(claude[1]), start: claude[2] };
          else wt.locked = true;
        }
        if (key === 'prunable') wt.prunable = true;
      }
      return wt;
    })
    .filter((wt) => wt.path && !wt.prunable && fs.existsSync(wt.path));
}

function claudeLockAlive({ pid, start }) {
  try {
    return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19] === start;
  } catch {
    return false;
  }
}

const worktreeName = (wtPath) => (wtPath === REPO ? 'main' : path.basename(wtPath));

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readReview(name) {
  const meta = readJson(path.join(REVIEWS_DIR, `${name}.json`));
  const report = readJson(path.join(REVIEWS_DIR, `${name}.report.json`));
  if (!meta && !report) return null;
  return { pr: meta?.pr || report?.pr?.url || null, startedAt: meta?.startedAt || null, report: report && Array.isArray(report.blocks) ? report : null };
}

function parseStatus(out) {
  const files = [];
  let ahead = 0;
  let behind = 0;
  let upstream = null;
  for (const line of (out || '').split('\n')) {
    if (line.startsWith('# branch.ab ')) {
      const [, , a, b] = line.split(' ');
      ahead = Number(a);
      behind = -Number(b);
    } else if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length);
    } else if (line.startsWith('1 ')) {
      const parts = line.split(' ');
      files.push({ code: parts[1], path: parts.slice(8).join(' ') });
    } else if (line.startsWith('2 ')) {
      const parts = line.split(' ');
      files.push({ code: parts[1], path: parts.slice(9).join(' ').split('\t')[0] });
    } else if (line.startsWith('u ')) {
      const parts = line.split(' ');
      files.push({ code: 'UU', path: parts.slice(10).join(' ') });
    } else if (line.startsWith('? ')) {
      files.push({ code: '??', path: line.slice(2) });
    }
  }
  return { files, ahead, behind, upstream };
}

function parseNumstat(out) {
  const stats = {};
  for (const line of (out || '').split('\n')) {
    const [added, deleted, ...rest] = line.split('\t');
    if (!rest.length) continue;
    stats[rest.join('\t')] = { added: Number(added) || 0, deleted: Number(deleted) || 0 };
  }
  return stats;
}

function loadStore(name, fallback) {
  return readJson(path.join(DATA_DIR, name)) ?? fallback;
}

function saveStore(name, data) {
  const file = path.join(DATA_DIR, name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function readCheckpoints(sessionId) {
  const list = readJson(path.join(STATE_DIR, `${sessionId}.checkpoints.json`));
  return Array.isArray(list) ? list : [];
}

function writeSessionState(session) {
  const file = path.join(STATE_DIR, `${session.sessionId}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(session));
  fs.renameSync(tmp, file);
}

function readSession(sessionId) {
  if (!/^[\w-]+$/.test(sessionId)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, `${sessionId}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function readSessions() {
  try {
    return fs
      .readdirSync(STATE_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readSession(f.slice(0, -5)))
      .filter((s) => s && s.cwd && Date.now() - s.updatedAt < SESSION_MAX_AGE_MS);
  } catch {
    return [];
  }
}

async function livePanes() {
  const result = await tmux(['list-panes', '-a', '-F', '#{pane_id}\t#{session_name}\t#{pane_dead}\t#{session_created}']);
  const panes = new Map();
  if (!result.ok) return panes;
  for (const line of result.stdout.split('\n')) {
    const [id, session, dead, created] = line.split('\t');
    if (id && dead !== '1') panes.set(id, { session, created: Number(created) * 1000 });
  }
  panes.bySession = claudePanes(panes);
  return panes;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function claudePanes(panes) {
  const bySession = new Map();
  let files = [];
  try {
    files = fs.readdirSync(CLAUDE_SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {}
  for (const file of files) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(CLAUDE_SESSIONS_DIR, file), 'utf8'));
      const pane = /(%\d+)$/.exec(entry.tmux || '')?.[1];
      if (entry.sessionId && pane && panes.has(pane) && processAlive(entry.pid)) bySession.set(entry.sessionId, pane);
    } catch {}
  }
  return bySession;
}

function paneOf(session, panes) {
  if (!session) return null;
  const pane = session.tmuxPane && session.status !== 'ended' ? panes.get(session.tmuxPane) : null;
  if (pane && !(session.tmuxPaneSince && pane.created > session.tmuxPaneSince + 5000)) return session.tmuxPane;
  return panes.bySession?.get(session.sessionId) || null;
}

function hasTranscript(session) {
  return !!session.transcriptPath && fs.existsSync(session.transcriptPath);
}

const repoCache = new Map();
const REPO_CACHE_TTL_MS = 30000;

function repoLabel(remote, top) {
  const match = String(remote || '').trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return match ? match[1] : path.basename(top);
}

async function repoOf(dir) {
  const cached = repoCache.get(dir);
  if (cached && Date.now() - cached.at < REPO_CACHE_TTL_MS) return cached.info;
  const top = ((await git(dir, ['rev-parse', '--show-toplevel'])) || '').trim();
  let info = null;
  if (top) {
    const [branch, remote] = await Promise.all([git(top, ['branch', '--show-current']), git(top, ['remote', 'get-url', 'origin'])]);
    info = { path: top, name: repoLabel(remote, top), branch: (branch || '').trim() || null };
  }
  repoCache.set(dir, { at: Date.now(), info });
  return info;
}

async function externalRepos(session, ownPath) {
  const dirs = new Set();
  for (const action of session.actions || []) {
    if (!['Edit', 'Write', 'NotebookEdit'].includes(action.tool) || !action.detail) continue;
    const dir = path.dirname(path.resolve(session.cwd, action.detail));
    let existing = dir;
    while (existing !== '/' && !fs.existsSync(existing)) existing = path.dirname(existing);
    dirs.add(existing);
  }
  const repos = new Map();
  for (const dir of dirs) {
    const info = await repoOf(dir);
    if (info && info.path !== ownPath) repos.set(info.path, info);
  }
  return [...repos.values()];
}

function ownerOf(cwd, worktrees) {
  return worktrees
    .filter((wt) => cwd === wt.path || cwd.startsWith(`${wt.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

async function describe(wt) {
  const [status, numstat, lastCommit] = await Promise.all([
    git(wt.path, ['status', '--porcelain=v2', '--branch']),
    git(wt.path, ['diff', '--numstat']),
    git(wt.path, ['log', '-1', '--format=%s%x00%ct']),
  ]);
  const parsed = parseStatus(status);
  const stats = parseNumstat(numstat);
  const [subject, ts] = (lastCommit || '').trim().split('\0');
  const isUnstaged = (f) => f.code.charAt(1) !== '.';
  const files = parsed.files.filter(isUnstaged).map((f) => ({ ...f, ...(stats[f.path] || {}) }));
  return {
    name: worktreeName(wt.path),
    path: wt.path,
    branch: wt.branch || null,
    head: wt.head ? wt.head.slice(0, 7) : null,
    headSha: wt.head || null,
    detached: !!wt.detached,
    locked: !!wt.locked,
    files,
    staged: parsed.files.filter((f) => f.code.charAt(0) !== '.' && !['??', 'UU'].includes(f.code)).length,
    added: files.reduce((sum, f) => sum + (f.added || 0), 0),
    deleted: files.reduce((sum, f) => sum + (f.deleted || 0), 0),
    ahead: parsed.ahead,
    behind: parsed.behind,
    upstream: parsed.upstream,
    lastCommit: subject ? { subject, at: Number(ts) * 1000 } : null,
    review: readReview(worktreeName(wt.path)),
    sessions: [],
  };
}

let cache = null;
async function snapshot() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  const [worktrees, panes, app] = await Promise.all([listWorktrees(), livePanes(), appState()]);
  const described = await Promise.all(worktrees.map(describe));
  const byPath = new Map(described.map((d) => [d.path, d]));
  const snapshots = readUsageSnapshots();
  const usageBySession = new Map(snapshots.map((u) => [u.sessionId, u]));
  const queues = loadStore('worktree-queue.json', {});
  const links = loadStore('worktree-links.json', {});
  for (const session of readSessions()) {
    const owner = fs.existsSync(session.cwd) && ownerOf(session.cwd, worktrees);
    if (!owner) continue;
    const live = !!paneOf(session, panes);
    if (!live && !hasTranscript(session)) continue;
    const usage = usageBySession.get(session.sessionId);
    byPath.get(owner.path).sessions.push({
      ...session,
      actions: session.actions || [],
      live,
      usage: usage ? { context: usage.context, costUsd: usage.costUsd, at: usage.at } : null,
      checkpoints: readCheckpoints(session.sessionId),
      queue: queues[session.sessionId] || [],
      externalRepos: await externalRepos(session, owner.path),
    });
  }
  const byName = new Map(described.map((d) => [d.name, d]));
  for (const d of described) {
    d.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    d.pr = (d.branch && prCache.get(d.branch)?.pr) || null;
    d.parent = links[d.name] || null;
  }
  for (const d of described) {
    d.children = Object.entries(links)
      .filter(([, link]) => d.sessions.some((s) => s.sessionId === link.parentSessionId))
      .map(([name]) => ({ name, status: byName.get(name)?.sessions[0]?.status || (byName.has(name) ? 'none' : 'closed') }));
  }
  const shellLive = [...panes.values()].some((p) => p.session === SHELL_SESSION);
  const data = {
    generatedAt: Date.now(),
    repo: REPO,
    repoName: (await repoOf(REPO))?.name || path.basename(REPO),
    baseBranch: BASE_BRANCH,
    tick: TICK_ENABLED,
    worktrees: described,
    shell: { live: shellLive },
    app,
    limits: latestLimits(snapshots),
    archives: loadStore('worktree-archive.json', []),
    unread: eventsStore.events.filter((e) => !e.read).length,
    lastEventId: eventsStore.seq,
    pr: { enabled: ghAvailable, labels: CONFIG.pr?.labels || [], assignee: CONFIG.pr?.assignee || '' },
  };
  cache = { at: Date.now(), data };
  return data;
}

const validSha = (sha) => /^[0-9a-f]{40}$/.test(String(sha || ''));

async function changesSince(wtPath, since) {
  if (!validSha(since) || !(await listWorktrees()).some((wt) => wt.path === wtPath)) return null;
  const [numstat, names] = await Promise.all([git(wtPath, ['diff', '--numstat', since]), git(wtPath, ['diff', '--name-status', since])]);
  if (numstat === null) return null;
  const stats = parseNumstat(numstat);
  return (names || '').split('\n').filter(Boolean).map((line) => {
    const [code, ...rest] = line.split('\t');
    const file = rest[rest.length - 1];
    return { code: code.charAt(0), path: file, ...(stats[file] || {}) };
  });
}

async function diff(wtPath, file, since) {
  const worktrees = await listWorktrees();
  if (!worktrees.some((wt) => wt.path === wtPath)) return null;
  const full = path.resolve(wtPath, file);
  if (!full.startsWith(`${wtPath}/`)) return null;
  if (since) return validSha(since) ? (await git(wtPath, ['diff', since, '--', file])) || '' : null;
  const tracked = await git(wtPath, ['ls-files', '--error-unmatch', '--', file]);
  if (tracked !== null) return (await git(wtPath, ['diff', '--', file])) || '';
  const untracked = fs.statSync(full, { throwIfNoEntry: false })?.isDirectory()
    ? ((await git(wtPath, ['ls-files', '--others', '--exclude-standard', '--', file])) || '').split('\n').filter(Boolean)
    : [file];
  const diffs = await Promise.all(untracked.map(async (f) => (await run('git', ['-C', wtPath, 'diff', '--no-index', '--', '/dev/null', f])).stdout));
  return diffs.join('');
}

function transcriptFor(session) {
  if (!session) return null;
  const candidates = [session.transcriptPath, path.join(PROJECTS_DIR, session.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${session.sessionId}.jsonl`)];
  return candidates.find((p) => p && path.resolve(p).startsWith(`${PROJECTS_DIR}/`) && fs.existsSync(p)) || null;
}

function readUsageSnapshots() {
  let files = [];
  try {
    files = fs.readdirSync(USAGE_DIR).filter((f) => f.endsWith('.json'));
  } catch {}
  const since = Date.now() - USAGE_DAYS * 86400000;
  return files.map((f) => readJson(path.join(USAGE_DIR, f))).filter((u) => u?.sessionId && u.at >= since);
}

function latestLimits(snapshots) {
  const latest = snapshots.filter((u) => u.rateLimits).sort((a, b) => b.at - a.at)[0];
  return latest ? { ...latest.rateLimits, at: latest.at } : null;
}

function usageWorktree(cwd) {
  const match = String(cwd || '').match(/\.claude\/worktrees\/([^/]+)/);
  if (match) return match[1];
  if (cwd === REPO || String(cwd || '').startsWith(`${REPO}/`)) return 'main';
  return cwd ? path.basename(cwd) : '?';
}

const emptyTotals = () => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });

function addTotals(into, from) {
  for (const key of Object.keys(into)) into[key] += from[key];
}

function jsonlFiles(dir, since, depth = 0) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {}
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return depth < 3 ? jsonlFiles(full, since, depth + 1) : [];
    if (!entry.name.endsWith('.jsonl')) return [];
    const stat = fs.statSync(full, { throwIfNoEntry: false });
    return stat && stat.mtimeMs >= since ? [{ file: full, size: stat.size }] : [];
  });
}

const transcriptUsage = new Map();

function scanTranscript(file, size, tzOffsetMs) {
  let entry = transcriptUsage.get(file);
  if (!entry || size < entry.offset || entry.tzOffsetMs !== tzOffsetMs) entry = { offset: 0, tzOffsetMs, cwd: null, seen: new Set(), days: new Map() };
  if (size > entry.offset) {
    const buffer = Buffer.alloc(size - entry.offset);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buffer, 0, buffer.length, entry.offset);
    } finally {
      fs.closeSync(fd);
    }
    const end = buffer.lastIndexOf(10);
    if (end >= 0) {
      entry.offset += end + 1;
      for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
        if (entry.cwd && !line.includes('"usage"')) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        entry.cwd = entry.cwd || row.cwd || null;
        const usage = row.message?.usage;
        if (row.type !== 'assistant' || !usage || !row.timestamp) continue;
        const id = row.message.id || row.requestId;
        if (id && entry.seen.has(id)) continue;
        if (id) entry.seen.add(id);
        const day = new Date(Date.parse(row.timestamp) - tzOffsetMs).toISOString().slice(0, 10);
        if (!entry.days.has(day)) entry.days.set(day, emptyTotals());
        addTotals(entry.days.get(day), {
          input: usage.input_tokens || 0,
          cacheWrite: usage.cache_creation_input_tokens || 0,
          cacheRead: usage.cache_read_input_tokens || 0,
          output: usage.output_tokens || 0,
        });
      }
    }
  }
  transcriptUsage.set(file, entry);
  return entry;
}

let historyCache = null;
function usageHistory(tzOffsetMin) {
  const tzOffsetMs = (Number.isFinite(tzOffsetMin) ? Math.max(-840, Math.min(840, tzOffsetMin)) : 0) * 60000;
  if (historyCache && historyCache.tzOffsetMs === tzOffsetMs && Date.now() - historyCache.at < HISTORY_CACHE_TTL_MS) return historyCache.data;
  const dayKeys = Array.from({ length: USAGE_DAYS }, (_, i) => new Date(Date.now() - tzOffsetMs - (USAGE_DAYS - 1 - i) * 86400000).toISOString().slice(0, 10));
  const today = dayKeys[dayKeys.length - 1];
  const days = new Map(dayKeys.map((d) => [d, emptyTotals()]));
  const worktrees = new Map();
  for (const { file, size } of jsonlFiles(PROJECTS_DIR, Date.now() - (USAGE_DAYS + 1) * 86400000)) {
    const entry = scanTranscript(file, size, tzOffsetMs);
    const name = usageWorktree(entry.cwd);
    for (const [day, totals] of entry.days) {
      if (!days.has(day)) continue;
      addTotals(days.get(day), totals);
      if (!worktrees.has(name)) worktrees.set(name, { name, week: emptyTotals(), today: emptyTotals() });
      addTotals(worktrees.get(name).week, totals);
      if (day === today) addTotals(worktrees.get(name).today, totals);
    }
  }
  const total = (t) => t.input + t.cacheWrite + t.cacheRead + t.output;
  const snapshots = readUsageSnapshots();
  const data = {
    generatedAt: Date.now(),
    limits: latestLimits(snapshots),
    days: [...days].map(([date, totals]) => ({ date, ...totals })),
    worktrees: [...worktrees.values()].sort((a, b) => total(b.week) - total(a.week)),
    sessions: snapshots
      .sort((a, b) => b.at - a.at)
      .slice(0, USAGE_SESSIONS_MAX)
      .map((u) => ({ sessionId: u.sessionId, worktree: usageWorktree(u.cwd), model: u.model, context: u.context, costUsd: u.costUsd, at: u.at })),
  };
  historyCache = { at: Date.now(), tzOffsetMs, data };
  return data;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  return '';
}

function userText(raw) {
  const command = raw.match(/<command-name>([^<]+)<\/command-name>/);
  if (command) {
    const args = raw.match(/<command-args>([^<]*)<\/command-args>/);
    return `${command[1]}${args && args[1] ? ` ${args[1]}` : ''}`;
  }
  const cleaned = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!cleaned || /^<(local-command|bash-|task-notification)/.test(cleaned)) return null;
  return cleaned;
}

function summarizeToolInput(input = {}) {
  return input.description || input.command || input.file_path || input.pattern || input.prompt || input.skill || input.url || input.query || JSON.stringify(input).slice(0, 200);
}

function readChat(sessionId) {
  const file = transcriptFor(readSession(sessionId));
  return file ? readChatFile(file, sessionId) : null;
}

function readChatFile(file, sessionId) {
  const items = [];
  const tools = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.isSidechain || entry.isMeta || !entry.message) continue;
    const at = Date.parse(entry.timestamp) || null;
    const content = entry.message.content;
    if (entry.type === 'user') {
      if (typeof content === 'string') {
        const text = userText(content);
        if (text) items.push({ kind: 'user', text, at });
        continue;
      }
      for (const block of content || []) {
        if (block.type === 'tool_result' && tools.has(block.tool_use_id)) {
          const result = textOf(block.content);
          const tool = tools.get(block.tool_use_id);
          tool.result = result.length > TOOL_RESULT_MAX_CHARS ? `${result.slice(0, TOOL_RESULT_MAX_CHARS)}\n…` : result;
          tool.error = !!block.is_error;
        } else if (block.type === 'text') {
          const text = userText(block.text);
          if (text) items.push({ kind: 'user', text, at });
        }
      }
    } else if (entry.type === 'assistant') {
      for (const block of content || []) {
        if (block.type === 'text' && block.text.trim()) items.push({ kind: 'assistant', text: block.text, at });
        if (block.type === 'tool_use') {
          const tool = { kind: 'tool', tool: block.name, detail: String(summarizeToolInput(block.input)), at };
          tools.set(block.id, tool);
          items.push(tool);
        }
      }
    }
  }
  return { sessionId, total: items.length, items: items.slice(-CHAT_MAX_ITEMS) };
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

function pm2DaemonAlive() {
  try {
    process.kill(Number(fs.readFileSync(PM2_PID_FILE, 'utf8').trim()), 0);
    return true;
  } catch {
    return false;
  }
}

async function pm2Processes() {
  if (!USE_PM2 || !pm2DaemonAlive()) return [];
  const result = await run(PM2_BIN, ['jlist']);
  const start = result.stdout.indexOf('[');
  if (!result.ok || start < 0) return [];
  try {
    return JSON.parse(result.stdout.slice(start))
      .filter((p) => !p.name.startsWith('version:'))
      .map((p) => {
        const env = p.pm2_env || {};
        const restarts = env.restart_time || 0;
        const looping = env.status === 'online' && restarts >= 3 && Date.now() - (env.pm_uptime || 0) < CRASH_LOOP_UPTIME_MS;
        const finished = env.status === 'stopped' && env.exit_code === 0;
        return { name: p.name, status: env.status, restarts, exitCode: env.exit_code ?? null, looping, finished };
      });
  } catch {
    return [];
  }
}

function httpStatus(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
  });
}

async function buildPane() {
  if (!(await tmux(['has-session', '-t', APP_SESSION])).ok) return null;
  const info = await tmux(['display-message', '-p', '-t', `${APP_SESSION}:`, '#{pane_dead}\t#{pane_dead_status}\t#{session_created}']);
  if (!info.ok) return null;
  const [dead, code, created] = info.stdout.trim().split('\t');
  const tail = await tmux(['capture-pane', '-p', '-J', '-t', `${APP_SESSION}:`, '-S', '-40']);
  const lastLine = stripAnsi(tail.stdout).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('Pane is dead')).pop() || '';
  return { running: dead !== '1', exitCode: dead === '1' ? Number(code) : null, startedAt: Number(created) * 1000, lastLine: lastLine.slice(0, 160) };
}

async function appState() {
  if (!APP) return null;
  const [build, processes, code] = await Promise.all([buildPane(), pm2Processes(), APP.healthUrl ? httpStatus(APP.healthUrl) : null]);
  const answering = code === null ? null : !!code && code !== 503;
  const base = { link: APP.url || APP.healthUrl || null, usesPm2: USE_PM2, recoveryDoc: APP.recoveryDoc || null, build, processes, serving: loadStore('worktree-app-serve.json', null) };
  if (build && !build.running && build.exitCode !== 0) return { ...base, state: 'ko', reason: `La commande de lancement a échoué (code ${build.exitCode})` };
  if (build?.running && answering !== true) return { ...base, state: 'building' };
  if (!build?.running && !processes.length && answering !== true) return { ...base, state: 'stopped' };
  const failed = processes.filter((p) => p.status !== 'online' && !p.finished);
  const looping = processes.filter((p) => p.looping);
  const warnings = [
    failed.length ? `Process arrêtés : ${failed.map((p) => `${p.name}${p.exitCode ? ` (code ${p.exitCode})` : ''}`).join(', ')}` : null,
    looping.length ? `Redémarrent en boucle : ${looping.map((p) => `${p.name} (${p.restarts}×)`).join(', ')}` : null,
  ].filter(Boolean);
  if (answering === false && warnings.length) return { ...base, state: 'ko', reason: warnings.join(' · '), warnings };
  if (answering === false) return { ...base, state: 'starting', reason: code ? `${APP.healthUrl} répond encore 503` : `${APP.healthUrl} ne répond pas encore`, warnings };
  if (warnings.length) return { ...base, state: 'degraded', reason: warnings.join(' · '), warnings };
  return { ...base, state: 'up', warnings };
}

async function startApp({ restart }) {
  const current = await appState();
  if (!current) return { error: "Aucune app configurée (app.command dans cockpit.config.json)." };
  if (current.state === 'building') return { error: 'Un build est déjà en cours.' };
  if (['up', 'degraded', 'starting'].includes(current.state) && !restart) return { error: "L'app tourne déjà." };
  await tmux(['kill-session', '-t', APP_SESSION]);
  const result = await tmux([
    'new-session', '-d', '-s', APP_SESSION, ...TMUX_SIZE, '-c', REPO, '-e', TMUX_PATH,
    'bash', '-lc', USE_PM2 ? `"${PM2_BIN}" delete all >/dev/null 2>&1; ${APP.command}` : APP.command,
    ';', 'set-option', '-t', APP_SESSION, 'remain-on-exit', 'on',
  ]);
  return result.ok ? { ok: true } : { error: result.stderr.trim() };
}

async function stopApp() {
  await tmux(['kill-session', '-t', APP_SESSION]);
  if (USE_PM2 && pm2DaemonAlive()) await run(PM2_BIN, ['delete', 'all']);
  return { ok: true };
}

async function ensureShell() {
  if ((await tmux(['has-session', '-t', SHELL_SESSION])).ok) return;
  await tmux(['new-session', '-d', '-s', SHELL_SESSION, ...TMUX_SIZE, '-c', REPO, '-e', TMUX_PATH, 'bash', '-l']);
}

async function resolveTarget(target) {
  if (target === 'shell') {
    await ensureShell();
    return `${SHELL_SESSION}:`;
  }
  if (target === 'app') return (await tmux(['has-session', '-t', APP_SESSION])).ok ? `${APP_SESSION}:` : null;
  return paneOf(readSession(String(target || '')), await livePanes());
}

async function pasteText(target, text) {
  const buffer = `cw-${process.pid}-${Date.now()}`;
  await tmux(['load-buffer', '-b', buffer, '-'], text);
  await tmux(['paste-buffer', '-p', '-d', '-b', buffer, '-t', target]);
}

async function sendOps(target, ops) {
  for (const op of ops) {
    if (typeof op.literal === 'string' && op.literal) await tmux(['send-keys', '-t', target, '-l', op.literal]);
    else if (NAMED_KEYS.has(op.key)) await tmux(['send-keys', '-t', target, op.key]);
  }
}

async function screen(target) {
  const result = await tmux(['capture-pane', '-p', '-e', '-t', target, '-S', `-${SCREEN_HISTORY_LINES}`]);
  return result.ok ? result.stdout.replace(/\s+$/, '') : null;
}

function validName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(name);
}

function reviewSkills(wtPath) {
  if (Array.isArray(CONFIG.review?.skills)) return CONFIG.review.skills;
  const found = [path.join(wtPath, '.claude', 'skills'), path.join(os.homedir(), '.claude', 'skills')].flatMap((dir) => {
    try {
      return fs.readdirSync(dir).filter((name) => /review/i.test(name) && fs.existsSync(path.join(dir, name, 'SKILL.md')));
    } catch {
      return [];
    }
  });
  return ['code-review', 'security-review', ...found];
}

function reviewSystemPrompt(skills, reportFile) {
  return [
    'This session is a pull request review started from the worktree cockpit.',
    `Review skills available in this session: ${skills.join(', ')}.`,
    'Start with the review-context skill: read the ticket linked in the pull request, its comments and the Slack threads they point to, before judging any code.',
    'Before reading the pull request, load with the Skill tool the review skills that fit it: always code-review, plus the specialised ones whose description matches what the pull request touches. Run them, then check every finding against the code before keeping it.',
    'Never post, comment, approve or request changes on the pull request yourself.',
    `When the review is done, write the report with the review-report skill to ${reportFile}: the cockpit renders it as colored blocks, one per finding. Then give a short summary in the conversation.`,
  ].join('\n');
}

async function startSession({ worktree, prompt, kind, pr, parent }) {
  const name = String(worktree || '').trim();
  if (!validName(name)) return { error: 'Nom de worktree invalide (lettres, chiffres, . _ -).' };
  const review = kind === 'review';
  const prRef = String(pr || '').trim();
  if (review && !/^(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+(\/[\w./-]*)?|#?\d+)$/.test(prRef)) return { error: 'PR invalide : un lien GitHub de pull request ou un numéro.' };
  const existing = (await listWorktrees()).find((wt) => worktreeName(wt.path) === name);
  const args = existing ? [] : ['--worktree', name];
  if (review) {
    fs.mkdirSync(REVIEWS_DIR, { recursive: true });
    fs.rmSync(path.join(REVIEWS_DIR, `${name}.report.json`), { force: true });
    fs.writeFileSync(path.join(REVIEWS_DIR, `${name}.json`), JSON.stringify({ kind: 'review', pr: prRef, startedAt: Date.now() }));
    const skills = [...new Set(['review-context', ...reviewSkills(existing ? existing.path : REPO), 'review-report'])];
    args.push('--append-system-prompt', reviewSystemPrompt(skills, path.join(REVIEWS_DIR, `${name}.report.json`)));
    prompt = `Review the pull request ${prRef}.${prompt && String(prompt).trim() ? `\n\n${String(prompt).trim()}` : ''}`;
  }
  if (prompt && String(prompt).trim()) args.push(String(prompt));
  const session = `cw-${name}-${Date.now().toString(36).slice(-4)}`;
  const result = await tmux(['new-session', '-d', '-s', session, ...TMUX_SIZE, '-c', existing ? existing.path : REPO, '-e', TMUX_PATH, CLAUDE_BIN, ...args]);
  if (!result.ok) return { error: result.stderr.trim() };
  const parentSession = parent?.sessionId ? readSession(String(parent.sessionId)) : null;
  if (parentSession) {
    const links = loadStore('worktree-links.json', {});
    links[name] = { parentSessionId: parentSession.sessionId, parentWorktree: usageWorktree(parentSession.cwd), notify: !!parent.notify, createdAt: Date.now() };
    saveStore('worktree-links.json', links);
  }
  return { session };
}

async function resumeSession({ session: sessionId }) {
  const session = readSession(String(sessionId || ''));
  if (!session || !fs.existsSync(session.cwd)) return { error: 'Session inconnue.' };
  if (paneOf(session, await livePanes())) return { error: 'La session tourne déjà dans tmux.' };
  if (!hasTranscript(session)) return { error: 'Cette session n’a aucun message : rien à reprendre.' };
  const name = `cw-${path.basename(session.cwd)}-${Date.now().toString(36).slice(-4)}`;
  const result = await tmux(['new-session', '-d', '-s', name, ...TMUX_SIZE, '-c', session.cwd, '-e', TMUX_PATH, CLAUDE_BIN, '--resume', session.sessionId]);
  return result.ok ? { session: name } : { error: result.stderr.trim() };
}

function sessionsIn(wtPath) {
  return readSessions().filter((s) => s.cwd === wtPath || s.cwd.startsWith(`${wtPath}/`));
}

async function removeWorktree(wt, force) {
  const panes = await livePanes();
  for (const session of sessionsIn(wt.path)) {
    const pane = paneOf(session, panes);
    if (pane) await tmux(['kill-pane', '-t', pane]);
    writeSessionState({ ...session, status: 'ended', tmuxPane: null, updatedAt: Date.now() });
  }
  if (wt.claudeLock) {
    for (let i = 0; i < 20 && claudeLockAlive(wt.claudeLock); i++) await sleep(150);
    if (claudeLockAlive(wt.claudeLock)) return { error: `Une session Claude ouverte hors cockpit tient ce worktree (pid ${wt.claudeLock.pid}) : quitte-la (/exit) puis réessaie.` };
    await run('git', ['-C', REPO, 'worktree', 'unlock', wt.path]);
  }
  const removed = await run('git', ['-C', REPO, 'worktree', 'remove', ...(force ? ['--force'] : []), wt.path]);
  return removed.ok ? { ok: true } : { error: removed.stderr.trim() };
}

async function closeWorktree({ path: wtPath, force, deleteBranch }) {
  const wt = (await listWorktrees()).find((w) => w.path === wtPath);
  if (!wt) return { error: 'Worktree inconnu.' };
  if (wt.path === REPO) return { error: 'Le repo principal ne peut pas être fermé.' };
  if (wt.locked) return { error: 'Ce worktree est verrouillé (git worktree unlock pour le libérer).' };
  const dirty = ((await git(wt.path, ['status', '--porcelain'])) || '').trim();
  if (dirty && !force) return { error: 'Ce worktree a des changements non commités.', dirty: true };

  const removed = await removeWorktree(wt, force);
  if (removed.error) return removed;
  for (const suffix of ['.json', '.report.json']) fs.rmSync(path.join(REVIEWS_DIR, `${worktreeName(wt.path)}${suffix}`), { force: true });
  if (deleteBranch && wt.branch) {
    const branch = await run('git', ['-C', REPO, 'branch', '-d', wt.branch]);
    if (!branch.ok) return { ok: true, warning: `Worktree fermé, branche ${wt.branch} conservée : ${branch.stderr.trim()}` };
  }
  return { ok: true };
}

const BUILTIN_COMMANDS = [
  ['add-dir', 'Ajouter un dossier de travail'],
  ['agents', 'Gérer les sous-agents', true],
  ['clear', "Vider l'historique de la conversation"],
  ['compact', 'Résumer la conversation pour libérer du contexte', false, '[instructions]'],
  ['config', 'Ouvrir les réglages', true],
  ['context', "Afficher l'usage du contexte"],
  ['cost', 'Afficher le coût et la durée de la session'],
  ['doctor', "Diagnostiquer l'installation"],
  ['exit', 'Quitter Claude Code'],
  ['help', "Afficher l'aide"],
  ['hooks', 'Gérer les hooks', true],
  ['init', 'Initialiser un CLAUDE.md'],
  ['mcp', 'Gérer les serveurs MCP', true],
  ['memory', 'Éditer les fichiers mémoire', true],
  ['model', 'Changer de modèle', true, '[modèle]'],
  ['permissions', 'Gérer les permissions', true],
  ['plugin', 'Gérer les plugins', true],
  ['resume', 'Reprendre une conversation', true],
  ['review', 'Relire une pull request'],
  ['rewind', 'Revenir à un point précédent', true],
  ['status', 'Afficher le statut', true],
  ['usage', "Afficher l'usage du forfait", true],
].map(([name, description, interactive = false, hint = '']) => ({ name, description, hint, interactive, source: 'builtin' }));

function frontmatter(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = {};
  if (!match) return meta;
  let key = null;
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([\w-]+):\s*(.*)$/);
    if (pair) {
      key = pair[1];
      meta[key] = /^[>|][-+]?$/.test(pair[2]) ? '' : pair[2].replace(/^(["'])(.*)\1$/, '$2');
    } else if (key && /^\s+\S/.test(line)) {
      meta[key] = `${meta[key]} ${line.trim()}`.trim();
    }
  }
  return meta;
}

function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink())).map((e) => e.name);
  } catch {
    return [];
  }
}

function skillsIn(dir, source, prefix = '') {
  return subdirs(dir).flatMap((name) => {
    const meta = frontmatter(path.join(dir, name, 'SKILL.md'));
    if (!meta || meta['user-invocable'] === 'false') return [];
    return [{ name: prefix + (meta.name || name), description: meta.description || '', hint: meta['argument-hint'] || '', source }];
  });
}

function commandsIn(dir, source, prefix = '') {
  const found = [];
  const walk = (current, parts) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(current, e.name);
      if (e.isDirectory()) walk(full, [...parts, e.name]);
      else if (e.name.endsWith('.md')) {
        const meta = frontmatter(full) || {};
        const name = meta.name || [...parts, e.name.slice(0, -3)].join(':');
        found.push({ name: prefix + name, description: meta.description || '', hint: meta['argument-hint'] || '', source });
      }
    }
  };
  walk(dir, []);
  return found;
}

function pluginCommands() {
  let installed;
  try {
    installed = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {};
  } catch {
    return [];
  }
  return Object.entries(installed).flatMap(([id, installs]) => {
    const install = Array.isArray(installs) ? installs[0] : installs;
    if (!install?.installPath) return [];
    const prefix = `${id.split('@')[0]}:`;
    return [...skillsIn(path.join(install.installPath, 'skills'), 'plugin', prefix), ...commandsIn(path.join(install.installPath, 'commands'), 'plugin', prefix)];
  });
}

const commandCache = new Map();

async function listCommands(wtPath) {
  if (!(await listWorktrees()).some((w) => w.path === wtPath)) return null;
  const cached = commandCache.get(wtPath);
  if (cached && Date.now() - cached.at < 10000) return cached.list;
  const userDir = path.join(os.homedir(), '.claude');
  const synced = path.join(userDir, 'skills', 'synced');
  const all = [
    ...skillsIn(path.join(wtPath, '.claude', 'skills'), 'project'),
    ...commandsIn(path.join(wtPath, '.claude', 'commands'), 'project'),
    ...skillsIn(path.join(userDir, 'skills'), 'user'),
    ...commandsIn(path.join(userDir, 'commands'), 'user'),
    ...subdirs(synced).flatMap((bucket) => skillsIn(path.join(synced, bucket), 'synced', 'anthropic-skills:')),
    ...pluginCommands(),
    ...BUILTIN_COMMANDS,
  ];
  const seen = new Set();
  const list = all.filter((c) => !seen.has(c.name) && seen.add(c.name));
  commandCache.set(wtPath, { at: Date.now(), list });
  return list;
}

const ghAvailable = (() => {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function gh(cwd, args) {
  return new Promise((resolve) => {
    execFile('gh', args, { cwd, maxBuffer: 20 * 1024 * 1024, timeout: 30000 }, (error, stdout, stderr) => resolve({ ok: !error, stdout: stdout || '', stderr: stderr || (error ? error.message : '') }));
  });
}

const prCache = new Map();
let prRefreshedAt = 0;

function checkState(c) {
  const conclusion = String(c.conclusion || c.state || '').toUpperCase();
  const status = String(c.status || '').toUpperCase();
  if (c.__typename === 'CheckRun' && status && status !== 'COMPLETED') return 'pending';
  if (['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS'].includes(conclusion)) return 'pending';
  if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(conclusion)) return 'failing';
  return 'passing';
}

function summarizePr(raw) {
  const checks = (raw.statusCheckRollup || []).map((c) => ({ name: c.name || c.context || '?', state: checkState(c), url: c.detailsUrl || c.targetUrl || null, startedAt: c.startedAt || null, completedAt: c.completedAt || null }));
  return {
    number: raw.number,
    url: raw.url,
    title: raw.title,
    state: raw.state,
    draft: !!raw.isDraft,
    review: raw.reviewDecision || null,
    mergeState: raw.mergeStateStatus || null,
    checks,
    failing: checks.filter((c) => c.state === 'failing').length,
    pending: checks.filter((c) => c.state === 'pending').length,
    passing: checks.filter((c) => c.state === 'passing').length,
  };
}

const PR_FIELDS = 'number,url,title,state,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup';

async function refreshPrs(worktrees) {
  if (!ghAvailable) return;
  prRefreshedAt = Date.now();
  for (const wt of worktrees) {
    if (!wt.branch || wt.branch === BASE_BRANCH || wt.path === REPO) continue;
    const result = await gh(REPO, ['pr', 'list', '--head', wt.branch, '--state', 'all', '--limit', '1', '--json', PR_FIELDS]);
    if (!result.ok) continue;
    let list = [];
    try {
      list = JSON.parse(result.stdout);
    } catch {}
    const before = prCache.get(wt.branch)?.pr;
    const pr = list[0] ? summarizePr(list[0]) : null;
    prCache.set(wt.branch, { at: Date.now(), pr });
    if (pr && before && !before.failing && pr.failing) pushEvent({ type: 'ci_failed', worktree: worktreeName(wt.path), path: wt.path, message: `CI en échec sur la PR #${pr.number}` });
    if (pr && before && before.state !== 'MERGED' && pr.state === 'MERGED') pushEvent({ type: 'merged', worktree: worktreeName(wt.path), path: wt.path, message: `PR #${pr.number} mergée : le worktree peut être archivé` });
  }
  cache = null;
}

const eventsStore = loadStore('worktree-events.json', { seq: 0, events: [] });

function pushEvent(event) {
  eventsStore.seq += 1;
  eventsStore.events.push({ id: eventsStore.seq, at: Date.now(), read: false, ...event });
  eventsStore.events = eventsStore.events.slice(-EVENTS_MAX);
  saveStore('worktree-events.json', eventsStore);
  notifyExternal(event);
}

function notifyExternal(event) {
  const url = CONFIG.notify?.ntfyUrl;
  const types = CONFIG.notify?.types || ['needs_input', 'permission', 'question', 'ci_failed', 'app_ko'];
  if (!url || !types.includes(event.type)) return;
  fetch(url, { method: 'POST', body: event.message || event.type, headers: { Title: `Cockpit · ${event.worktree || ''}`.trim(), Tags: event.type } }).catch(() => {});
}

function markEventsRead({ ids, all }) {
  const wanted = new Set((ids || []).map(Number));
  for (const e of eventsStore.events) if (all || wanted.has(e.id)) e.read = true;
  saveStore('worktree-events.json', eventsStore);
  cache = null;
  return { ok: true };
}

async function sendToSession(sessionId, text) {
  const pane = paneOf(readSession(String(sessionId || '')), await livePanes());
  if (!pane) return false;
  await pasteText(pane, text);
  await sleep(150);
  await tmux(['send-keys', '-t', pane, 'Enter']);
  return true;
}

function enqueue(sessionId, text) {
  const queues = loadStore('worktree-queue.json', {});
  const item = { id: crypto.randomBytes(4).toString('hex'), text: String(text), at: Date.now() };
  queues[sessionId] = [...(queues[sessionId] || []), item];
  saveStore('worktree-queue.json', queues);
  cache = null;
  return item;
}

function dequeue(sessionId, id) {
  const queues = loadStore('worktree-queue.json', {});
  queues[sessionId] = (queues[sessionId] || []).filter((item) => item.id !== id);
  if (!queues[sessionId].length) delete queues[sessionId];
  saveStore('worktree-queue.json', queues);
  cache = null;
  return { ok: true };
}

async function deliver(sessionId, text, queueWhenWaiting = false) {
  const session = readSession(String(sessionId || ''));
  if (!session) return 'unknown';
  if (!paneOf(session, await livePanes())) return 'offline';
  const busy = session.status === 'working' || (queueWhenWaiting && session.status === 'needs_input');
  if (busy && Date.now() - session.updatedAt < STALE_MS_SERVER) {
    enqueue(session.sessionId, text);
    return 'queued';
  }
  return (await sendToSession(session.sessionId, text)) ? 'sent' : 'offline';
}

const STALE_MS_SERVER = 30 * 60 * 1000;

async function broadcast({ targets, text }) {
  const message = String(text || '').trim();
  if (!message || !Array.isArray(targets) || !targets.length) return { error: 'Message ou sessions manquants.' };
  const report = { sent: [], queued: [], offline: [] };
  for (const target of targets.slice(0, 50)) {
    const outcome = await deliver(target, message, true);
    (report[outcome] || report.offline).push(target);
  }
  return report;
}

async function flushQueues(snap) {
  const queues = loadStore('worktree-queue.json', {});
  for (const wt of snap.worktrees) {
    for (const session of wt.sessions) {
      const items = queues[session.sessionId];
      if (!items?.length || !session.live || !['done', 'idle'].includes(session.status)) continue;
      const [first] = items;
      if (!(await sendToSession(session.sessionId, first.text))) continue;
      dequeue(session.sessionId, first.id);
      writeSessionState({ ...readSession(session.sessionId), status: 'working', updatedAt: Date.now() });
      lastStatus.set(session.sessionId, 'working');
    }
  }
}

const lastStatus = new Map();
let lastAppState = null;

function detectTransitions(snap) {
  const links = loadStore('worktree-links.json', {});
  for (const wt of snap.worktrees) {
    for (const session of wt.sessions) {
      const before = lastStatus.get(session.sessionId);
      lastStatus.set(session.sessionId, session.status);
      if (before === undefined || before === session.status) continue;
      const base = { worktree: wt.name, path: wt.path, sessionId: session.sessionId };
      if (session.status === 'needs_input') {
        const type = session.question ? 'question' : session.permission ? 'permission' : 'needs_input';
        pushEvent({ ...base, type, message: session.message || 'Claude attend ta réponse' });
      } else if (session.status === 'done' && before === 'working') {
        pushEvent({ ...base, type: 'done', message: session.lastAssistant || 'Tour terminé' });
        const link = links[wt.name];
        if (link?.notify && readSession(link.parentSessionId)) {
          enqueue(link.parentSessionId, `La session déléguée « ${wt.name} » a terminé son tour. Son dernier message :\n\n${session.lastAssistant || '(pas de message)'}`);
        }
      }
    }
  }
  const appNow = snap.app?.state || null;
  if (lastAppState && lastAppState !== 'ko' && appNow === 'ko') pushEvent({ type: 'app_ko', worktree: 'app', message: snap.app.reason || "L'app est KO" });
  lastAppState = appNow;
}

async function prDetails(wtPath) {
  const wt = (await listWorktrees()).find((w) => w.path === wtPath);
  if (!wt?.branch || !ghAvailable) return null;
  const result = await gh(REPO, ['pr', 'view', wt.branch, '--json', `${PR_FIELDS},reviews,mergeable,baseRefName,headRefName`]);
  if (!result.ok) return { none: true };
  try {
    const raw = JSON.parse(result.stdout);
    const pr = summarizePr(raw);
    prCache.set(wt.branch, { at: Date.now(), pr });
    const reviews = (raw.reviews || []).map((r) => ({ author: r.author?.login || '?', state: r.state, body: String(r.body || '').slice(0, 400), at: r.submittedAt }));
    return { ...pr, mergeable: raw.mergeable, base: raw.baseRefName, head: raw.headRefName, reviews };
  } catch {
    return null;
  }
}

async function sendCheckFailure({ path: wtPath, check }) {
  const details = await prDetails(wtPath);
  const failing = details?.checks?.find((c) => c.name === check && c.state === 'failing');
  if (!failing) return { error: 'Check introuvable ou plus en échec.' };
  const session = sessionsIn(wtPath).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!session) return { error: 'Aucune session Claude dans ce worktree.' };
  const ids = String(failing.url || '').match(/actions\/runs\/(\d+)(?:\/job\/(\d+))?/);
  let log = '';
  if (ids) {
    const result = await gh(REPO, ['run', 'view', ids[1], ...(ids[2] ? ['--job', ids[2]] : []), '--log-failed']);
    log = stripAnsi(result.stdout).split('\n').slice(-60).join('\n');
  }
  const text = `Le check « ${failing.name} » échoue sur la PR #${details.number}${failing.url ? ` (${failing.url})` : ''}.${log ? `\n\nFin du log en échec :\n\`\`\`\n${log}\n\`\`\`` : ''}\n\nAnalyse la cause et corrige-la.`;
  const outcome = await deliver(session.sessionId, text, true);
  return outcome === 'offline' || outcome === 'unknown' ? { error: 'La session ne tourne pas dans tmux.' } : { ok: true, outcome };
}

async function pushBranch({ path: wtPath }) {
  const wt = (await listWorktrees()).find((w) => w.path === wtPath);
  if (!wt?.branch || wt.path === REPO) return { error: 'Worktree sans branche, ou checkout principal.' };
  const result = await run('git', ['-C', wt.path, 'push', '-u', 'origin', wt.branch]);
  cache = null;
  return result.ok ? { ok: true } : { error: result.stderr.trim() };
}

const DEFAULT_PR_TEMPLATE = '## TL;DR\n\n\n## Ticket\n\n{ticket}\n\n## Points d\'attention\n\n\n## Comment tester\n\n';

async function prDraft(wtPath) {
  const wt = (await listWorktrees()).find((w) => w.path === wtPath);
  if (!wt?.branch) return null;
  await run('git', ['-C', wt.path, 'fetch', '-q', 'origin', BASE_BRANCH]);
  const commits = ((await git(wt.path, ['log', `origin/${BASE_BRANCH}..HEAD`, '--format=%s'])) || '').split('\n').filter(Boolean);
  const ticket = wt.branch.match(/[A-Z]+-\d+/i)?.[0]?.toUpperCase() || '';
  const template = CONFIG.pr?.template || DEFAULT_PR_TEMPLATE;
  return {
    branch: wt.branch,
    base: BASE_BRANCH,
    title: commits.length === 1 ? commits[0] : commits[commits.length - 1] || wt.branch,
    body: template.replace('{ticket}', ticket),
    commits,
    labels: CONFIG.pr?.labels || [],
    assignee: CONFIG.pr?.assignee || '',
  };
}

async function createPr({ path: wtPath, title, body, labels, assignee, draft }) {
  if (!ghAvailable) return { error: 'gh n’est pas installé.' };
  const wt = (await listWorktrees()).find((w) => w.path === wtPath);
  if (!wt?.branch || wt.path === REPO) return { error: 'Worktree sans branche, ou checkout principal.' };
  if (!String(title || '').trim()) return { error: 'Titre manquant.' };
  const pushed = await pushBranch({ path: wt.path });
  if (pushed.error) return pushed;
  const labelList = (Array.isArray(labels) ? labels : []).map(String).filter(Boolean);
  const args = ['pr', 'create', '--title', String(title).trim(), '--body', String(body || ''), '--base', BASE_BRANCH, '--head', wt.branch, ...(draft ? ['--draft'] : []), ...labelList.flatMap((l) => ['--label', l]), ...(assignee ? ['--assignee', String(assignee)] : [])];
  const created = await gh(wt.path, args);
  if (!created.ok) return { error: created.stderr.trim() };
  const view = await gh(wt.path, ['pr', 'view', wt.branch, '--json', 'url,number,labels,assignees,body']);
  let check = null;
  try {
    const pr = JSON.parse(view.stdout);
    const names = (pr.labels || []).map((l) => l.name);
    check = {
      url: pr.url,
      number: pr.number,
      labels: labelList.every((l) => names.includes(l)),
      assignee: !assignee || (pr.assignees || []).some((a) => a.login === assignee),
      footer: !/Generated with \[?Claude Code/i.test(pr.body || ''),
    };
  } catch {}
  prRefreshedAt = 0;
  return { ok: true, url: check?.url || created.stdout.trim(), check };
}

const sizeCache = new Map();

function dirSize(wtPath) {
  const cached = sizeCache.get(wtPath);
  if (cached && (cached.pending || Date.now() - cached.at < SIZE_TTL_MS)) return cached.kb ?? null;
  sizeCache.set(wtPath, { ...(cached || {}), pending: true });
  execFile('du', ['-sk', wtPath], { timeout: 120000 }, (error, stdout) => {
    sizeCache.set(wtPath, { at: Date.now(), kb: error ? cached?.kb ?? null : Number(String(stdout).split('\t')[0]) || null });
  });
  return cached?.kb ?? null;
}

async function cleanupList() {
  const snap = await snapshot();
  await run('git', ['-C', REPO, 'fetch', '-q', 'origin', BASE_BRANCH]);
  return Promise.all(snap.worktrees.filter((w) => w.path !== REPO).map(async (w) => {
    const merged = w.headSha ? (await run('git', ['-C', REPO, 'merge-base', '--is-ancestor', w.headSha, `origin/${BASE_BRANCH}`])).ok : false;
    let mtime = 0;
    try {
      mtime = fs.statSync(w.path).mtimeMs;
    } catch {}
    const lastActivity = Math.max(mtime, w.lastCommit?.at || 0, ...w.sessions.map((s) => s.updatedAt || 0));
    return { name: w.name, path: w.path, branch: w.branch, dirty: w.files.length, ahead: w.ahead, upstream: w.upstream, merged, pr: w.pr ? { number: w.pr.number, state: w.pr.state } : null, live: w.sessions.some((s) => s.live), locked: w.locked, lastActivity, sizeKb: dirSize(w.path) };
  }));
}

async function archiveWorktree({ path: wtPath }) {
  const wt = (await listWorktrees()).find((w) => w.path === wtPath);
  if (!wt) return { error: 'Worktree inconnu.' };
  if (wt.path === REPO) return { error: 'Le repo principal ne peut pas être archivé.' };
  if (wt.locked) return { error: 'Ce worktree est verrouillé.' };
  if (((await git(wt.path, ['status', '--porcelain'])) || '').trim()) return { error: 'Ce worktree a des changements non commités : commite-les avant d’archiver, ou ferme-le.' };
  const sessions = sessionsIn(wt.path).filter(hasTranscript).sort((a, b) => b.updatedAt - a.updatedAt);
  const entry = {
    name: worktreeName(wt.path),
    path: wt.path,
    branch: wt.branch || null,
    head: wt.head || null,
    sessions: sessions.map((s) => ({ sessionId: s.sessionId, task: s.task || null, lastAssistant: s.lastAssistant || null })),
    pr: (wt.branch && prCache.get(wt.branch)?.pr) ? { number: prCache.get(wt.branch).pr.number, url: prCache.get(wt.branch).pr.url, state: prCache.get(wt.branch).pr.state } : null,
    archivedAt: Date.now(),
  };
  const removed = await removeWorktree(wt, false);
  if (removed.error) return removed;
  const archives = loadStore('worktree-archive.json', []).filter((a) => a.name !== entry.name);
  saveStore('worktree-archive.json', [entry, ...archives].slice(0, 200));
  cache = null;
  return { ok: true };
}

async function unarchiveWorktree({ name, resume }) {
  const archives = loadStore('worktree-archive.json', []);
  const entry = archives.find((a) => a.name === name);
  if (!entry) return { error: 'Archive inconnue.' };
  if (fs.existsSync(entry.path)) return { error: `${entry.path} existe déjà.` };
  const hasBranch = entry.branch && (await run('git', ['-C', REPO, 'rev-parse', '--verify', '--quiet', `refs/heads/${entry.branch}`])).ok;
  const added = await run('git', ['-C', REPO, 'worktree', 'add', ...(hasBranch ? [entry.path, entry.branch] : ['--detach', entry.path, entry.head || 'HEAD'])]);
  if (!added.ok) return { error: added.stderr.trim() };
  saveStore('worktree-archive.json', archives.filter((a) => a.name !== name));
  cache = null;
  const last = entry.sessions?.[0];
  if (resume && last) {
    const tmuxName = `cw-${entry.name}-${Date.now().toString(36).slice(-4)}`;
    const started = await tmux(['new-session', '-d', '-s', tmuxName, ...TMUX_SIZE, '-c', entry.path, '-e', TMUX_PATH, CLAUDE_BIN, '--resume', last.sessionId]);
    if (!started.ok) return { ok: true, warning: `Worktree restauré, mais la session n’a pas pu reprendre : ${started.stderr.trim()}` };
  }
  return { ok: true, branchRestored: !!hasBranch };
}

async function serveWorktree({ path: wtPath }) {
  if (!APP) return { error: 'Aucune app configurée.' };
  const wt = (await listWorktrees()).find((w) => w.path === wtPath);
  if (!wt?.head || wt.path === REPO) return { error: 'Worktree inconnu, ou checkout principal.' };
  const dirty = ((await git(REPO, ['status', '--porcelain', '--untracked-files=no'])) || '').trim();
  if (dirty) return { error: 'Le checkout principal a des changements non commités : impossible de basculer.' };
  const current = loadStore('worktree-app-serve.json', null);
  const previous = current?.previous || ((await git(REPO, ['branch', '--show-current'])) || '').trim() || ((await git(REPO, ['rev-parse', 'HEAD'])) || '').trim();
  const checkout = await run('git', ['-C', REPO, 'checkout', '--detach', wt.head]);
  if (!checkout.ok) return { error: checkout.stderr.trim() };
  saveStore('worktree-app-serve.json', { name: worktreeName(wt.path), branch: wt.branch, sha: wt.head, previous, at: Date.now() });
  cache = null;
  return startApp({ restart: true });
}

async function unserveWorktree() {
  const current = loadStore('worktree-app-serve.json', null);
  if (!current) return { error: 'L’app sert déjà le checkout principal.' };
  const checkout = await run('git', ['-C', REPO, 'checkout', current.previous]);
  if (!checkout.ok) return { error: checkout.stderr.trim() };
  fs.rmSync(path.join(DATA_DIR, 'worktree-app-serve.json'), { force: true });
  cache = null;
  return startApp({ restart: true });
}

async function restoreCheckpoint({ path: wtPath, sha }) {
  if (!validSha(sha)) return { error: 'Checkpoint invalide.' };
  const wt = (await listWorktrees()).find((w) => w.path === wtPath);
  if (!wt) return { error: 'Worktree inconnu.' };
  const known = sessionsIn(wt.path).some((s) => readCheckpoints(s.sessionId).some((c) => c.sha === sha));
  if (!known) return { error: 'Ce checkpoint n’appartient à aucune session de ce worktree.' };
  const result = await run('git', ['-C', wt.path, 'checkout', sha, '--', '.']);
  cache = null;
  return result.ok ? { ok: true } : { error: result.stderr.trim() };
}

const PROJECT_PREFIX = REPO.replace(/[^a-zA-Z0-9]/g, '-');
const historyIndex = new Map();

function historyFiles() {
  let dirs = [];
  try {
    dirs = fs.readdirSync(PROJECTS_DIR).filter((d) => d === PROJECT_PREFIX || d.startsWith(`${PROJECT_PREFIX}-`));
  } catch {}
  return dirs
    .flatMap((d) => {
      try {
        return fs.readdirSync(path.join(PROJECTS_DIR, d)).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(PROJECTS_DIR, d, f));
      } catch {
        return [];
      }
    })
    .map((file) => ({ file, stat: fs.statSync(file, { throwIfNoEntry: false }) }))
    .filter((f) => f.stat)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(0, HISTORY_FILES_MAX);
}

function historyMeta({ file, stat }) {
  const cached = historyIndex.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.meta;
  const meta = { sessionId: path.basename(file, '.jsonl'), file, cwd: null, branch: null, title: null, messages: 0, files: new Set(), startedAt: null, lastAt: stat.mtimeMs };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.isSidechain || !entry.message) continue;
    meta.cwd = meta.cwd || entry.cwd || null;
    meta.branch = entry.gitBranch || meta.branch;
    const at = Date.parse(entry.timestamp);
    if (at) {
      meta.startedAt = meta.startedAt || at;
      meta.lastAt = at;
    }
    const content = entry.message.content;
    if (entry.type === 'user' && !entry.isMeta) {
      const text = typeof content === 'string' ? userText(content) : null;
      if (text) {
        meta.messages += 1;
        meta.title = meta.title || text.slice(0, 160);
      }
    } else if (entry.type === 'assistant') {
      for (const block of content || []) {
        if (block.type === 'text') meta.messages += 1;
        if (block.type === 'tool_use' && ['Edit', 'Write', 'NotebookEdit'].includes(block.name) && block.input?.file_path && meta.files.size < 30) meta.files.add(block.input.file_path);
      }
    }
  }
  const result = { ...meta, files: [...meta.files].map((f) => (meta.cwd && f.startsWith(`${meta.cwd}/`) ? f.slice(meta.cwd.length + 1) : f)), worktree: usageWorktree(meta.cwd), exists: !!meta.cwd && fs.existsSync(meta.cwd) };
  historyIndex.set(file, { mtimeMs: stat.mtimeMs, meta: result });
  return result;
}

function searchHistory(query, limit = 80) {
  const q = String(query || '').trim().toLowerCase();
  const out = [];
  for (const f of historyFiles()) {
    const meta = historyMeta(f);
    if (!meta.messages) continue;
    if (!q) {
      out.push(meta);
    } else {
      const text = fs.readFileSync(f.file, 'utf8');
      const index = text.toLowerCase().indexOf(q);
      if (index < 0 && !meta.files.some((p) => p.toLowerCase().includes(q))) continue;
      const snippet = index < 0 ? '' : text.slice(Math.max(0, index - 80), index + q.length + 120).replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/[{}"\\]+/g, ' ').replace(/\s+/g, ' ').trim();
      out.push({ ...meta, snippet });
    }
    if (out.length >= limit) break;
  }
  return out;
}

function historyFile(sessionId) {
  return historyFiles().find((f) => path.basename(f.file, '.jsonl') === sessionId) || null;
}

async function resumeFromHistory({ session: sessionId }) {
  if (!/^[\w-]+$/.test(String(sessionId || ''))) return { error: 'Session invalide.' };
  const found = historyFile(sessionId);
  if (!found) return { error: 'Session introuvable.' };
  const meta = historyMeta(found);
  if (!meta.cwd) return { error: 'Dossier de la session inconnu.' };
  if (!fs.existsSync(meta.cwd)) {
    const inWorktrees = meta.cwd.startsWith(`${REPO}/.claude/worktrees/`);
    const hasBranch = meta.branch && (await run('git', ['-C', REPO, 'rev-parse', '--verify', '--quiet', `refs/heads/${meta.branch}`])).ok;
    if (!inWorktrees || !hasBranch) return { error: `Le dossier ${meta.cwd} n’existe plus et sa branche est introuvable.` };
    const added = await run('git', ['-C', REPO, 'worktree', 'add', meta.cwd, meta.branch]);
    if (!added.ok) return { error: added.stderr.trim() };
  }
  const name = `cw-${path.basename(meta.cwd)}-${Date.now().toString(36).slice(-4)}`;
  const result = await tmux(['new-session', '-d', '-s', name, ...TMUX_SIZE, '-c', meta.cwd, '-e', TMUX_PATH, CLAUDE_BIN, '--resume', sessionId]);
  cache = null;
  return result.ok ? { ok: true, worktree: usageWorktree(meta.cwd) } : { error: result.stderr.trim() };
}

function loadAutomations() {
  return loadStore('worktree-automations.json', []);
}

function saveAutomation({ item }) {
  const name = String(item?.name || '').trim();
  const worktree = String(item?.worktree || '').trim();
  const prompt = String(item?.prompt || '').trim();
  const schedule = item?.schedule || {};
  if (!name || !prompt) return { error: 'Nom et prompt obligatoires.' };
  if (!validName(worktree)) return { error: 'Nom de worktree invalide.' };
  if (schedule.type === 'daily' && !/^\d{2}:\d{2}$/.test(String(schedule.time))) return { error: 'Heure invalide (HH:MM).' };
  if (schedule.type === 'interval' && !(Number(schedule.minutes) >= 10)) return { error: 'Intervalle de 10 minutes minimum.' };
  if (!['daily', 'interval'].includes(schedule.type)) return { error: 'Planification invalide.' };
  const list = loadAutomations();
  const id = item.id && list.some((a) => a.id === item.id) ? item.id : crypto.randomBytes(4).toString('hex');
  const clean = {
    id,
    name,
    worktree,
    newWorktree: !!item.newWorktree,
    prompt,
    enabled: item.enabled !== false,
    tzOffsetMin: Number.isFinite(Number(item.tzOffsetMin)) ? Number(item.tzOffsetMin) : 0,
    schedule: schedule.type === 'daily' ? { type: 'daily', time: schedule.time, days: (schedule.days || [1, 2, 3, 4, 5]).map(Number).filter((d) => d >= 0 && d <= 6) } : { type: 'interval', minutes: Number(schedule.minutes) },
    createdAt: list.find((a) => a.id === id)?.createdAt || Date.now(),
    lastRun: list.find((a) => a.id === id)?.lastRun || null,
    lastWorktree: list.find((a) => a.id === id)?.lastWorktree || null,
    lastOk: list.find((a) => a.id === id)?.lastOk ?? null,
    lastResult: list.find((a) => a.id === id)?.lastResult || null,
  };
  saveStore('worktree-automations.json', [...list.filter((a) => a.id !== id), clean]);
  return { ok: true, id };
}

function deleteAutomation({ id }) {
  saveStore('worktree-automations.json', loadAutomations().filter((a) => a.id !== id));
  return { ok: true };
}

function nextRunOf(a, now = Date.now()) {
  if (!a.enabled) return null;
  if (a.schedule.type === 'interval') return a.lastRun ? Math.max(now, a.lastRun + a.schedule.minutes * 60000) : now;
  const [h, m] = a.schedule.time.split(':').map(Number);
  const local = new Date(now - a.tzOffsetMin * 60000);
  for (let d = 0; d < 8; d++) {
    const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + d, h, m));
    const slot = day.getTime() + a.tzOffsetMin * 60000;
    if (!a.schedule.days.includes(day.getUTCDay())) continue;
    if (slot > now || Math.max(a.lastRun || 0, a.createdAt || 0) < slot) return Math.max(slot, now);
  }
  return null;
}

function listAutomations() {
  const now = Date.now();
  return loadAutomations().map((a) => ({ ...a, nextRun: nextRunOf(a, now) }));
}

function automationDue(a, now) {
  if (!a.enabled) return false;
  if (a.schedule.type === 'interval') return !a.lastRun || now - a.lastRun >= a.schedule.minutes * 60000;
  const local = new Date(now - a.tzOffsetMin * 60000);
  const [h, m] = a.schedule.time.split(':').map(Number);
  if (!a.schedule.days.includes(local.getUTCDay())) return false;
  const slot = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h, m) + a.tzOffsetMin * 60000;
  return now >= slot && Math.max(a.lastRun || 0, a.createdAt || 0) < slot;
}

async function runAutomation(id) {
  const list = loadAutomations();
  const a = list.find((x) => x.id === id);
  if (!a) return { error: 'Automatisation inconnue.' };
  const stamp = new Date(Date.now() - a.tzOffsetMin * 60000).toISOString().slice(5, 16).replace(/[-:T]/g, '');
  const worktree = a.newWorktree ? `${a.worktree}-${stamp}` : a.worktree;
  const result = await startSession({ worktree, prompt: a.prompt });
  a.lastRun = Date.now();
  a.lastWorktree = result.error ? null : worktree;
  a.lastOk = !result.error;
  a.lastResult = result.error ? `Échec : ${result.error}` : `Lancée dans ${worktree}`;
  saveStore('worktree-automations.json', list);
  pushEvent({ type: result.error ? 'automation_failed' : 'automation', worktree, message: `${a.name} : ${a.lastResult}` });
  return result.error ? result : { ok: true, worktree };
}

async function runDueAutomations() {
  const now = Date.now();
  for (const a of loadAutomations()) if (automationDue(a, now)) await runAutomation(a.id);
}

let ticking = false;
let lastAutomationCheck = 0;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    cache = null;
    const snap = await snapshot();
    detectTransitions(snap);
    await flushQueues(snap);
    if (Date.now() - prRefreshedAt > PR_REFRESH_MS) refreshPrs(await listWorktrees()).catch(() => {});
    if (Date.now() - lastAutomationCheck > 30000) {
      lastAutomationCheck = Date.now();
      await runDueAutomations();
    }
  } catch (error) {
    console.error('tick failed', error);
  } finally {
    ticking = false;
  }
}

function readToken() {
  try {
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (token.length >= 32) return Buffer.from(token);
  } catch {}
  console.error(`Missing or invalid ${TOKEN_FILE}: run start.sh to generate it.`);
  process.exit(1);
}

const TOKEN = readToken();

function allowedHost(req) {
  try {
    return ALLOWED_HOSTS.has(new URL(`http://${req.headers.host}`).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function authorized(req) {
  const given = Buffer.from(String(req.headers['x-cockpit-token'] || ''));
  return given.length === TOKEN.length && crypto.timingSafeEqual(given, TOKEN);
}

function allowedWrite(req) {
  if (req.method !== 'POST' || req.headers['x-cockpit'] !== '1') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_MAX_BYTES) reject(new Error('body too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
  res.end(body);
}

const json = (res, status, data) => send(res, status, 'application/json', JSON.stringify(data));

const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

async function handleWrite(req, res, route) {
  if (!allowedWrite(req)) return json(res, 403, { error: 'Requête refusée.' });
  const body = await readBody(req);
  cache = null;
  if (route === '/api/restart') {
    json(res, 200, { ok: true, startedAt: STARTED_AT });
    setTimeout(() => spawn(path.join(__dirname, 'start.sh'), { detached: true, stdio: 'ignore' }).unref(), 200);
    return;
  }
  if (route === '/api/start') {
    const result = await startSession(body);
    return json(res, result.error ? 400 : 200, result);
  }
  if (route === '/api/resume') {
    const result = await resumeSession(body);
    return json(res, result.error ? 400 : 200, result);
  }
  if (route === '/api/app/start' || route === '/api/app/stop') {
    const result = route === '/api/app/start' ? await startApp(body) : await stopApp();
    return json(res, result.error ? 409 : 200, result);
  }
  if (route === '/api/close') {
    const result = await closeWorktree(body);
    return json(res, result.error ? (result.dirty ? 409 : 400) : 200, result);
  }
  const actions = {
    '/api/events/read': () => markEventsRead(body),
    '/api/queue/remove': () => dequeue(String(body.target || ''), String(body.id || '')),
    '/api/broadcast': () => broadcast(body),
    '/api/checks/send': () => sendCheckFailure(body),
    '/api/push': () => pushBranch(body),
    '/api/pr': () => createPr(body),
    '/api/archive': () => archiveWorktree(body),
    '/api/unarchive': () => unarchiveWorktree(body),
    '/api/app/serve': () => serveWorktree(body),
    '/api/app/unserve': () => unserveWorktree(),
    '/api/restore': () => restoreCheckpoint(body),
    '/api/history/resume': () => resumeFromHistory(body),
    '/api/automations/save': () => saveAutomation(body),
    '/api/automations/delete': () => deleteAutomation(body),
    '/api/automations/run': () => runAutomation(String(body.id || '')),
  };
  if (actions[route]) {
    const result = await actions[route]();
    cache = null;
    return json(res, result?.error ? 400 : 200, result);
  }
  if (route === '/api/queue') {
    const session = readSession(String(body.target || ''));
    if (!session || !String(body.text || '').trim()) return json(res, 400, { error: 'Session ou message manquant.' });
    return json(res, 200, enqueue(session.sessionId, String(body.text).trim()));
  }
  if (route === '/api/deliver') {
    const outcome = await deliver(body.target, String(body.text || '').trim());
    return json(res, ['sent', 'queued'].includes(outcome) ? 200 : 409, outcome === 'sent' || outcome === 'queued' ? { ok: true, outcome } : { error: 'Cette session ne tourne pas dans tmux, le cockpit ne peut pas lui écrire.' });
  }
  const target = await resolveTarget(body.target);
  if (!target) return json(res, 409, { error: 'Cette session ne tourne pas dans tmux, le cockpit ne peut pas lui écrire.' });
  if (route === '/api/send') {
    await pasteText(target, String(body.text || ''));
    await sleep(150);
    await tmux(['send-keys', '-t', target, 'Enter']);
    return json(res, 200, { ok: true });
  }
  if (route === '/api/paste') {
    await pasteText(target, String(body.text || ''));
    return json(res, 200, { ok: true });
  }
  if (route === '/api/keys') {
    await sendOps(target, Array.isArray(body.ops) ? body.ops.slice(0, 200) : []);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'not found' });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!allowedHost(req)) return send(res, 421, 'text/plain', 'Host not allowed. Add it to COCKPIT_HOSTS.');
      if (url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', page);
      if (!authorized(req)) return json(res, 401, { error: 'Token manquant ou invalide.' });
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) return await handleWrite(req, res, url.pathname);
      if (url.pathname === '/api/events') return json(res, 200, { events: eventsStore.events.slice(-100).reverse(), unread: eventsStore.events.filter((e) => !e.read).length, seq: eventsStore.seq });
      if (url.pathname === '/api/changes') {
        const list = await changesSince(url.searchParams.get('wt') || '', url.searchParams.get('since') || '');
        return list === null ? json(res, 400, { error: 'Checkpoint ou worktree invalide.' }) : json(res, 200, list);
      }
      if (url.pathname === '/api/checks') {
        const details = await prDetails(url.searchParams.get('wt') || '');
        return details === null ? json(res, 400, { error: 'Worktree sans branche, ou gh absent.' }) : json(res, 200, details);
      }
      if (url.pathname === '/api/pr-draft') {
        const draft = await prDraft(url.searchParams.get('wt') || '');
        return draft === null ? json(res, 400, { error: 'Worktree sans branche.' }) : json(res, 200, draft);
      }
      if (url.pathname === '/api/cleanup') return json(res, 200, await cleanupList());
      if (url.pathname === '/api/history') return json(res, 200, searchHistory(url.searchParams.get('q') || ''));
      if (url.pathname === '/api/history/chat') {
        const sessionId = url.searchParams.get('session') || '';
        const found = /^[\w-]+$/.test(sessionId) ? historyFile(sessionId) : null;
        return found ? json(res, 200, readChatFile(found.file, sessionId)) : send(res, 404, 'text/plain', 'session not found');
      }
      if (url.pathname === '/api/automations') return json(res, 200, listAutomations());
      if (url.pathname === '/api/state') return json(res, 200, { ...(await snapshot()), startedAt: STARTED_AT });
      if (url.pathname === '/api/app') return json(res, 200, await appState());
      if (url.pathname === '/api/usage') return json(res, 200, usageHistory(Number(url.searchParams.get('tz'))));
      if (url.pathname === '/api/chat') {
        const chat = readChat(url.searchParams.get('session') || '');
        return chat === null ? send(res, 404, 'text/plain', 'transcript not found') : json(res, 200, chat);
      }
      if (url.pathname === '/api/screen') {
        const target = await resolveTarget(url.searchParams.get('target'));
        const text = target ? await screen(target) : null;
        return text === null ? send(res, 409, 'text/plain', 'no tmux pane') : send(res, 200, 'text/plain; charset=utf-8', text);
      }
      if (url.pathname === '/api/commands') {
        const list = await listCommands(url.searchParams.get('path') || '');
        return list === null ? send(res, 400, 'text/plain', 'unknown worktree') : json(res, 200, list);
      }
      if (url.pathname === '/api/diff') {
        const result = await diff(url.searchParams.get('wt') || '', url.searchParams.get('file') || '', url.searchParams.get('since') || '');
        return result === null ? send(res, 400, 'text/plain', 'invalid path') : send(res, 200, 'text/plain; charset=utf-8', result);
      }
      send(res, 404, 'text/plain', 'not found');
    } catch (error) {
      send(res, 500, 'text/plain', String(error));
    }
  })
  .listen(PORT, HOST, () => {
    console.log(`Worktree dashboard on http://${HOST}:${PORT} (repo ${REPO})`);
    if (TICK_ENABLED) {
      tick();
      setInterval(tick, TICK_MS);
    }
  });
