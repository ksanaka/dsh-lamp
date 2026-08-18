import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';
import { STATES } from '../lib/state.js';

const { OFF, IDLE, WORKING, INPUT } = STATES;

/** Minimal Cordis-like context: collect listeners, dispatch on emit. */
function fakeCtx() {
  const handlers = new Map();
  return {
    logger: {
      info() {}, warn() {}, debug() {}, error() {},
    },
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    emit(name, ...args) {
      for (const handler of handlers.get(name) ?? []) handler(...args);
    },
    dispose() {
      for (const name of ['dispose']) {
        for (const handler of handlers.get(name) ?? []) handler();
      }
    },
  };
}

function setup(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lamp-test-'));
  const stateFile = join(dir, 'state');
  const ctx = fakeCtx();
  apply(ctx, {
    backend: 'loopbrew',
    stateFile,
    idleDelayMs: 0,
    sweepMs: 60_000,
    daemon: { autoStart: false },
    ...config,
  });
  return { dir, stateFile, ctx, read: () => readFileSync(stateFile, 'utf8').trim() };
}

test('plugin: writes working on a user prompt and idle on turn/end', () => {
  const { dir, stateFile, ctx, read } = setup();
  try {
    ctx.emit('session/event', { id: 's1' }, { type: 'agent/inbox/spliced', data: { inserted: [{ source: { kind: 'user' } }] } });
    assert.equal(read(), WORKING);
    ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } });
    assert.equal(read(), WORKING);
    ctx.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'complete' } } });
    assert.equal(read(), IDLE);
    assert.ok(stateFile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin: approval/asked lights input', () => {
  const { dir, ctx, read } = setup();
  try {
    ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } });
    ctx.emit('session/event', { id: 's1' }, { type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } });
    assert.equal(read(), INPUT);
    ctx.emit('session/event', { id: 's1' }, { type: 'approval/decided', data: { id: 'a1' } });
    assert.equal(read(), WORKING);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin: input outranks working across concurrent sessions', () => {
  const { dir, ctx, read } = setup();
  try {
    ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } });
    ctx.emit('session/event', { id: 's2' }, { type: 'turn/start', data: { turn: 1 } });
    assert.equal(read(), WORKING);
    ctx.emit('session/event', { id: 's2' }, { type: 'approval/asked', data: { id: 'a2', toolName: 'bash' } });
    assert.equal(read(), INPUT);
    // s1 finishes; s2 still waits -> stays input
    ctx.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'complete' } } });
    assert.equal(read(), INPUT);
    // s2 resolves -> working again
    ctx.emit('session/event', { id: 's2' }, { type: 'approval/decided', data: { id: 'a2' } });
    assert.equal(read(), WORKING);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin: session/end-seed and session/disposed drop sessions -> off', () => {
  const { dir, ctx, read } = setup();
  try {
    ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } });
    assert.equal(read(), WORKING);
    ctx.emit('session/event', { id: 's1' }, { type: 'session/end-seed' });
    assert.equal(read(), OFF);
    ctx.emit('session/created', { id: 's2' });
    assert.equal(read(), IDLE);
    ctx.emit('session/disposed', { id: 's2' });
    assert.equal(read(), OFF);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin: session/created seeds idle', () => {
  const { dir, ctx, read } = setup();
  try {
    ctx.emit('session/created', { id: 's1' });
    assert.equal(read(), IDLE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin: idle drop is debounced and cancellable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lamp-test-'));
  const stateFile = join(dir, 'state');
  const ctx = fakeCtx();
  apply(ctx, { backend: 'loopbrew', stateFile, idleDelayMs: 60, sweepMs: 60_000, daemon: { autoStart: false } });
  try {
    ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } });
    assert.equal(readFileSync(stateFile, 'utf8').trim(), WORKING);
    // turn/end schedules the drop; a new event within the delay cancels it.
    ctx.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'complete' } } });
    ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 2 } });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(readFileSync(stateFile, 'utf8').trim(), WORKING);
    // Now let it settle: turn/end then wait -> idle.
    ctx.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'complete' } } });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(readFileSync(stateFile, 'utf8').trim(), IDLE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin: dryRun never writes the state file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lamp-test-'));
  const stateFile = join(dir, 'state');
  const ctx = fakeCtx();
  apply(ctx, { stateFile, idleDelayMs: 0, sweepMs: 60_000, daemon: { autoStart: false }, dryRun: true });
  try {
    ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } });
    assert.throws(() => readFileSync(stateFile, 'utf8'), { code: 'ENOENT' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin: dispose cleans up timers (no crash)', () => {
  const { dir, ctx } = setup({ idleDelayMs: 5000 });
  try {
    ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } });
    ctx.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'complete' } } });
    ctx.dispose();
    assert.ok(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
