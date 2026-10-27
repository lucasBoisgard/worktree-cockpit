#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const CACHE_TTL_MS = 5000;
const USAGE_DIR = path.join(os.homedir(), '.claude', 'worktree-usage');

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function worktreeName(cwd) {
  const match = cwd.match(/\.claude\/worktrees\/([^/]+)/);
  return match ? match[1] : 'main';
}

function gitSummary(cwd) {
  const cacheFile = path.join('/tmp', `claude-statusline-${crypto.createHash('md5').update(cwd).digest('hex')}`);
  try {
    if (Date.now() - fs.statSync(cacheFile).mtimeMs < CACHE_TTL_MS) return fs.readFileSync(cacheFile, 'utf8');
  } catch {}

  const branch = git(cwd, ['branch', '--show-current']) || 'detached';
  const status = git(cwd, ['status', '--porcelain']);
  const dirty = status ? status.split('\n').filter(Boolean).length : 0;
  const ahead = git(cwd, ['rev-list', '--count', '@{u}..HEAD']);

  const parts = [branch, dirty ? `✎ ${dirty}` : '✓ clean'];
  if (ahead && ahead !== '0') parts.push(`↑${ahead} unpushed`);
  const summary = parts.join(' · ');

  try {
    fs.writeFileSync(cacheFile, summary);
  } catch {}
  return summary;
}

function recordUsage(input, cwd) {
  if (!/^[\w-]+$/.test(input.session_id || '')) return;
  const context = input.context_window || {};
  const usage = {
    sessionId: input.session_id,
    cwd,
    at: Date.now(),
    model: input.model?.display_name || null,
    context: {
      usedPercentage: context.used_percentage ?? null,
      size: context.context_window_size ?? null,
      inputTokens: context.total_input_tokens ?? null,
      outputTokens: context.total_output_tokens ?? null,
    },
    costUsd: input.cost?.total_cost_usd ?? null,
    rateLimits: input.rate_limits || null,
  };
  try {
    fs.mkdirSync(USAGE_DIR, { recursive: true });
    const file = path.join(USAGE_DIR, `${input.session_id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(usage));
    fs.renameSync(tmp, file);
  } catch {}
}

let raw = '';
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {}
  const cwd = input.workspace?.current_dir || input.cwd || process.cwd();
  recordUsage(input, cwd);
  const model = input.model?.display_name;
  const line = [`🌳 ${worktreeName(cwd)}`, gitSummary(cwd), model].filter(Boolean).join(' · ');
  process.stdout.write(line);
});
