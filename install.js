#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = __dirname;
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const SKILLS_DIR = path.join(CLAUDE_DIR, 'skills');
const CANONICAL_DIR = path.join(CLAUDE_DIR, 'worktree-dashboard');
const IS_CANONICAL = path.resolve(DIR) === CANONICAL_DIR;

function snippet() {
  const raw = fs.readFileSync(path.join(DIR, 'settings.snippet.json'), 'utf8');
  return JSON.parse(raw.split('/root/.claude/worktree-dashboard').join(DIR));
}

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
}

function commandsOf(groups) {
  return new Set((groups || []).flatMap((g) => (g.hooks || []).map((h) => h.command)));
}

function scriptOf(command) {
  const parts = String(command || '').trim().split(/\s+/);
  return parts[0] === 'node' ? parts[1] : parts[0];
}

function isStaleCockpitHook(command) {
  const script = scriptOf(command);
  return !!script && script.includes('/worktree-dashboard') && !fs.existsSync(script);
}

function dropStaleHooks(settings, changes) {
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isStaleCockpitHook(h.command)) }))
      .filter((g) => g.hooks.length);
    if (kept.length !== groups.length || kept.some((g, i) => g.hooks.length !== groups[i].hooks.length)) changes.push(`stale ${event} hook removed`);
    settings.hooks[event] = kept;
  }
}

function mergeSettings() {
  const settings = readSettings();
  const wanted = snippet();
  const changes = [];

  dropStaleHooks(settings, changes);
  if (!IS_CANONICAL) {
    console.log(`install.js runs from ${DIR}, not ${CANONICAL_DIR}: hooks, status line and skills are only installed from the shared checkout`);
    if (changes.length) writeSettings(settings, changes);
    return;
  }

  if (!settings.statusLine) {
    settings.statusLine = wanted.statusLine;
    changes.push('statusLine');
  } else if (settings.statusLine.command !== wanted.statusLine.command) {
    console.log(`statusLine already set to "${settings.statusLine.command}", left untouched`);
  }

  settings.hooks = settings.hooks || {};
  for (const [event, groups] of Object.entries(wanted.hooks)) {
    const existing = commandsOf(settings.hooks[event]);
    for (const group of groups) {
      if (group.hooks.every((h) => existing.has(h.command))) continue;
      settings.hooks[event] = [...(settings.hooks[event] || []), group];
      changes.push(`hook ${event}`);
    }
  }

  if (changes.length) writeSettings(settings, changes);
}

function writeSettings(settings, changes) {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, `${SETTINGS}.bak-cockpit-${Date.now()}`);
  const tmp = `${SETTINGS}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(tmp, SETTINGS);
  console.log(`settings.json updated (${changes.join(', ')}); restart your Claude sessions to load the hooks`);
}

function linkSkills() {
  const source = path.join(DIR, 'skills');
  if (!IS_CANONICAL || !fs.existsSync(source)) return;
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  for (const name of fs.readdirSync(source)) {
    const target = path.join(SKILLS_DIR, name);
    if (fs.lstatSync(target, { throwIfNoEntry: false })) continue;
    fs.symlinkSync(path.join(source, name), target);
    console.log(`skill ${name} linked`);
  }
}

function ensureToken() {
  const file = path.join(DIR, 'token');
  if (fs.existsSync(file)) {
    fs.chmodSync(file, 0o600);
    return;
  }
  fs.writeFileSync(file, `${crypto.randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
  console.log('access token generated');
}

mergeSettings();
linkSkills();
ensureToken();
