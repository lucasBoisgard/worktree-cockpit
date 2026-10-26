#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
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
const PORT = Number(process.env.PORT || 4747);
const HOST = process.env.HOST || '127.0.0.1';
const REPO = process.env.REPO || CONFIG.repo || detectRepo();
const CLAUDE_BIN = process.env.CLAUDE_BIN || CONFIG.claudeBin || path.join(os.homedir(), '.local', 'bin', 'claude');
const STATE_DIR = path.join(os.homedir(), '.claude', 'worktree-state');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
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
        if (key === 'detached') wt.detached = true;
        if (key === 'locked') wt.locked = true;
        if (key === 'prunable') wt.prunable = true;
      }
      return wt;
    })
    .filter((wt) => wt.path && !wt.prunable && fs.existsSync(wt.path));
}

const worktreeName = (wtPath) => (wtPath === REPO ? 'main' : path.basename(wtPath));

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
  return panes;
}

function paneOf(session, panes) {
  if (!session?.tmuxPane || session.status === 'ended') return null;
  const pane = panes.get(session.tmuxPane);
  if (!pane) return null;
  if (session.tmuxPaneSince && pane.created > session.tmuxPaneSince + 5000) return null;
  return session.tmuxPane;
}

function ownerOf(cwd, worktrees) {
  return worktrees
    .filter((wt) => cwd === wt.path || cwd.startsWith(`${wt.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

async function describe(wt) {
  const [status, numstat, lastCommit] = await Promise.all([
    git(wt.path, ['status', '--porcelain=v2', '--branch']),
    git(wt.path, ['diff', 'HEAD', '--numstat']),
    git(wt.path, ['log', '-1', '--format=%s%x00%ct']),
  ]);
  const parsed = parseStatus(status);
  const stats = parseNumstat(numstat);
  const [subject, ts] = (lastCommit || '').trim().split('\0');
  const files = parsed.files.map((f) => ({ ...f, ...(stats[f.path] || {}) }));
  return {
    name: worktreeName(wt.path),
    path: wt.path,
    branch: wt.branch || null,
    detached: !!wt.detached,
    locked: !!wt.locked,
    files,
    added: files.reduce((sum, f) => sum + (f.added || 0), 0),
    deleted: files.reduce((sum, f) => sum + (f.deleted || 0), 0),
    ahead: parsed.ahead,
    behind: parsed.behind,
    upstream: parsed.upstream,
    lastCommit: subject ? { subject, at: Number(ts) * 1000 } : null,
    sessions: [],
  };
}

let cache = null;
async function snapshot() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  const [worktrees, panes, app] = await Promise.all([listWorktrees(), livePanes(), appState()]);
  const described = await Promise.all(worktrees.map(describe));
  const byPath = new Map(described.map((d) => [d.path, d]));
  for (const session of readSessions()) {
    const owner = ownerOf(session.cwd, worktrees);
    if (!owner) continue;
    byPath.get(owner.path).sessions.push({ ...session, actions: session.actions || [], live: !!paneOf(session, panes) });
  }
  for (const d of described) d.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  const shellLive = [...panes.values()].some((p) => p.session === SHELL_SESSION);
  const data = { generatedAt: Date.now(), repo: REPO, worktrees: described, shell: { live: shellLive }, app };
  cache = { at: Date.now(), data };
  return data;
}

async function diff(wtPath, file) {
  const worktrees = await listWorktrees();
  if (!worktrees.some((wt) => wt.path === wtPath)) return null;
  const full = path.resolve(wtPath, file);
  if (!full.startsWith(`${wtPath}/`)) return null;
  const tracked = await git(wtPath, ['ls-files', '--error-unmatch', '--', file]);
  if (tracked !== null) return (await git(wtPath, ['diff', 'HEAD', '--', file])) || '';
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
  if (!file) return null;
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
  const base = { link: APP.url || APP.healthUrl || null, usesPm2: USE_PM2, recoveryDoc: APP.recoveryDoc || null, build, processes };
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

async function startSession({ worktree, prompt }) {
  const name = String(worktree || '').trim();
  if (!validName(name)) return { error: 'Nom de worktree invalide (lettres, chiffres, . _ -).' };
  const existing = (await listWorktrees()).find((wt) => worktreeName(wt.path) === name);
  const args = existing ? [] : ['--worktree', name];
  if (prompt && String(prompt).trim()) args.push(String(prompt));
  const session = `cw-${name}-${Date.now().toString(36).slice(-4)}`;
  const result = await tmux(['new-session', '-d', '-s', session, ...TMUX_SIZE, '-c', existing ? existing.path : REPO, '-e', TMUX_PATH, CLAUDE_BIN, ...args]);
  return result.ok ? { session } : { error: result.stderr.trim() };
}

async function resumeSession({ session: sessionId }) {
  const session = readSession(String(sessionId || ''));
  if (!session || !fs.existsSync(session.cwd)) return { error: 'Session inconnue.' };
  if (paneOf(session, await livePanes())) return { error: 'La session tourne déjà dans tmux.' };
  const name = `cw-${path.basename(session.cwd)}-${Date.now().toString(36).slice(-4)}`;
  const result = await tmux(['new-session', '-d', '-s', name, ...TMUX_SIZE, '-c', session.cwd, '-e', TMUX_PATH, CLAUDE_BIN, '--resume', session.sessionId]);
  return result.ok ? { session: name } : { error: result.stderr.trim() };
}

async function closeWorktree({ path: wtPath, force, deleteBranch }) {
  const wt = (await listWorktrees()).find((w) => w.path === wtPath);
  if (!wt) return { error: 'Worktree inconnu.' };
  if (wt.path === REPO) return { error: 'Le repo principal ne peut pas être fermé.' };
  if (wt.locked) return { error: 'Ce worktree est verrouillé (git worktree unlock pour le libérer).' };
  const dirty = ((await git(wt.path, ['status', '--porcelain'])) || '').trim();
  if (dirty && !force) return { error: 'Ce worktree a des changements non commités.', dirty: true };

  const panes = await livePanes();
  for (const session of readSessions()) {
    if (session.cwd !== wt.path && !session.cwd.startsWith(`${wt.path}/`)) continue;
    const pane = paneOf(session, panes);
    if (pane) await tmux(['kill-pane', '-t', pane]);
    fs.writeFileSync(path.join(STATE_DIR, `${session.sessionId}.json`), JSON.stringify({ ...session, status: 'ended', tmuxPane: null, updatedAt: Date.now() }));
  }

  const removed = await run('git', ['-C', REPO, 'worktree', 'remove', ...(force ? ['--force'] : []), wt.path]);
  if (!removed.ok) return { error: removed.stderr.trim() };
  if (deleteBranch && wt.branch) {
    const branch = await run('git', ['-C', REPO, 'branch', '-d', wt.branch]);
    if (!branch.ok) return { ok: true, warning: `Worktree fermé, branche ${wt.branch} conservée : ${branch.stderr.trim()}` };
  }
  return { ok: true };
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
      if (['/api/start', '/api/resume', '/api/close', '/api/app/start', '/api/app/stop', '/api/send', '/api/paste', '/api/keys'].includes(url.pathname)) return await handleWrite(req, res, url.pathname);
      if (url.pathname === '/api/state') return json(res, 200, await snapshot());
      if (url.pathname === '/api/app') return json(res, 200, await appState());
      if (url.pathname === '/api/chat') {
        const chat = readChat(url.searchParams.get('session') || '');
        return chat === null ? send(res, 404, 'text/plain', 'transcript not found') : json(res, 200, chat);
      }
      if (url.pathname === '/api/screen') {
        const target = await resolveTarget(url.searchParams.get('target'));
        const text = target ? await screen(target) : null;
        return text === null ? send(res, 409, 'text/plain', 'no tmux pane') : send(res, 200, 'text/plain; charset=utf-8', text);
      }
      if (url.pathname === '/api/diff') {
        const result = await diff(url.searchParams.get('wt') || '', url.searchParams.get('file') || '');
        return result === null ? send(res, 400, 'text/plain', 'invalid path') : send(res, 200, 'text/plain; charset=utf-8', result);
      }
      send(res, 404, 'text/plain', 'not found');
    } catch (error) {
      send(res, 500, 'text/plain', String(error));
    }
  })
  .listen(PORT, HOST, () => console.log(`Worktree dashboard on http://${HOST}:${PORT} (repo ${REPO})`));
