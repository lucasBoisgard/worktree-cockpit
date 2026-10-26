#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATE_DIR = path.join(os.homedir(), '.claude', 'worktree-state');
const MAX_ACTIONS = 15;

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
    state.startedAt = state.startedAt || now;
    state.updatedAt = now;

    switch (input.hook_event_name) {
      case 'SessionStart':
        state.status = state.status || 'idle';
        break;
      case 'UserPromptSubmit':
        state.status = 'working';
        state.task = shorten(input.prompt, 220);
        state.message = null;
        break;
      case 'PreToolUse':
        state.status = 'working';
        state.message = null;
        state.actions = [{ tool: input.tool_name, detail: describeTool(input.tool_name, input.tool_input, cwd), at: now }, ...(state.actions || [])].slice(0, MAX_ACTIONS);
        break;
      case 'Notification':
        if (input.notification_type === 'idle_prompt' || /waiting for your input/i.test(input.message || '')) return;
        state.status = 'needs_input';
        state.message = shorten(input.message, 220);
        break;
      case 'Stop':
        if (input.stop_hook_active) return;
        state.status = 'done';
        state.message = null;
        break;
      case 'SessionEnd':
        state.status = 'ended';
        break;
      default:
        return;
    }

    writeState(file, state);
  } catch {}
});
