#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const STATE_DIR = path.join(os.homedir(), '.claude', 'worktree-state');
const MAX_ACTIONS = 15;
const MAX_CHECKPOINTS = 30;

const CHECKPOINT_SCRIPT = `
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const [cwd, file, at, prompt, max] = process.argv.slice(1);
const git = (args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
try {
  const sha = git(['stash', 'create']) || git(['rev-parse', 'HEAD']);
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  list.push({ at: Number(at), sha, prompt });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list.slice(-Number(max))));
  fs.renameSync(tmp, file);
} catch {}
`;

function recordCheckpoint(sessionId, cwd, at, prompt) {
  const file = path.join(STATE_DIR, `${sessionId}.checkpoints.json`);
  spawn(process.execPath, ['-e', CHECKPOINT_SCRIPT, cwd, file, String(at), prompt, String(MAX_CHECKPOINTS)], { detached: true, stdio: 'ignore' }).unref();
}

function questionOf(input = {}) {
  const first = Array.isArray(input.questions) ? input.questions[0] : null;
  if (!first) return null;
  return { text: shorten(first.question, 220), options: (first.options || []).map((o) => shorten(o.label, 60)).slice(0, 6), multi: !!first.multiSelect };
}

function shorten(text, max = 140) {
  const oneLine = String(text || '').replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function describeTool(name, input = {}, cwd) {
  const rel = (p) => (p ? path.relative(cwd, p) || p : '');
  switch (name) {
    case 'Bash':
      return shorten(input.description || input.command);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return rel(input.file_path || input.notebook_path);
    case 'Grep':
    case 'Glob':
      return shorten(input.pattern);
    case 'Agent':
    case 'Task':
      return shorten(input.description);
    case 'Skill':
      return input.skill || '';
    case 'WebFetch':
      return shorten(input.url);
    case 'WebSearch':
      return shorten(input.query);
    default:
      return '';
  }
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { actions: [] };
  }
}

function writeState(file, state) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

let raw = '';
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    if (!input.session_id) return;
    fs.mkdirSync(STATE_DIR, { recursive: true });

    const file = path.join(STATE_DIR, `${input.session_id}.json`);
    const state = readState(file);
    const now = Date.now();
    const cwd = input.cwd || state.cwd || process.cwd();

    state.sessionId = input.session_id;
    state.cwd = cwd;
    state.transcriptPath = input.transcript_path || state.transcriptPath;
    const pane = process.env.TMUX_PANE || null;
    if (input.hook_event_name === 'SessionStart' || (pane && pane !== state.tmuxPane)) {
      if (pane !== state.tmuxPane) state.tmuxPaneSince = now;
      state.tmuxPane = pane;
    }
    const previous = { status: state.status, since: state.statusSince || state.updatedAt || now, updatedAt: state.updatedAt || now };
    state.startedAt = state.startedAt || now;
    state.updatedAt = now;

    switch (input.hook_event_name) {
      case 'SessionStart':
        state.status = state.status || 'idle';
        break;
      case 'UserPromptSubmit':
        state.status = 'working';
        state.turnStartedAt = now;
        state.task = state.task || shorten(input.prompt, 220);
        state.lastPrompt = shorten(input.prompt, 220);
        state.message = null;
        state.question = null;
        recordCheckpoint(input.session_id, cwd, now, shorten(input.prompt, 120));
        break;
      case 'PreToolUse':
        state.actions = [{ tool: input.tool_name, detail: describeTool(input.tool_name, input.tool_input, cwd), at: now }, ...(state.actions || [])].slice(0, MAX_ACTIONS);
        if (input.tool_name === 'AskUserQuestion') {
          state.question = questionOf(input.tool_input);
          state.status = 'needs_input';
          state.message = state.question?.text || 'Claude pose une question';
        } else {
          state.status = 'working';
          state.message = null;
          state.question = null;
          state.permission = false;
        }
        break;
      case 'Notification':
        if (input.notification_type === 'idle_prompt' || /waiting for your input/i.test(input.message || '')) return;
        state.status = 'needs_input';
        state.message = shorten(input.message, 220);
        state.permission = /permission/i.test(input.message || '');
        break;
      case 'Stop':
        if (input.stop_hook_active) return;
        state.status = 'done';
        state.message = null;
        state.question = null;
        state.permission = false;
        if (input.last_assistant_message) state.lastAssistant = shorten(input.last_assistant_message, 400);
        break;
      case 'SessionEnd':
        state.status = 'ended';
        break;
      default:
        return;
    }

    const restarted = input.hook_event_name === 'UserPromptSubmit' && previous.status === 'working';
    if (state.status !== previous.status || restarted) {
      if (previous.status === 'working') state.workedMs = (state.workedMs || 0) + Math.max(0, (restarted ? previous.updatedAt : now) - previous.since);
      state.statusSince = now;
    }
    writeState(file, state);
  } catch {}
});
