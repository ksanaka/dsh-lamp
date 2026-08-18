import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATES,
  DEFAULT_PRIORITY,
  reduceSession,
  aggregate,
} from '../lib/state.js';

const { OFF, IDLE, WORKING, INPUT } = STATES;

test('reduceSession: a queued user prompt -> working', () => {
  assert.equal(reduceSession(OFF, {
    type: 'agent/inbox/spliced',
    data: {
      target: 'next-turn',
      start: 0,
      inserted: [{ source: { kind: 'user' }, role: 'user', content: [] }],
    },
  }), WORKING);
});

test('reduceSession: an inbox splice without user content leaves state unchanged', () => {
  assert.equal(reduceSession(IDLE, {
    type: 'agent/inbox/spliced',
    data: { target: 'next-turn', start: 0, inserted: [] },
  }), IDLE);
  assert.equal(reduceSession(IDLE, {
    type: 'agent/inbox/spliced',
    data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
  }), IDLE);
});

test('reduceSession: turn/start and step/start -> working', () => {
  assert.equal(reduceSession(OFF, { type: 'turn/start', data: { turn: 1 } }), WORKING);
  assert.equal(reduceSession(WORKING, { type: 'step/start', data: { turn: 1, step: 2 } }), WORKING);
});

test('reduceSession: tool/call -> working, ask_user_question -> input', () => {
  assert.equal(reduceSession(WORKING, {
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' },
  }), WORKING);
  assert.equal(reduceSession(WORKING, {
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'c2', name: 'ask_user_question', arguments: '{}' },
  }), INPUT);
});

test('reduceSession: approval/asked -> input, approval/decided -> working', () => {
  assert.equal(reduceSession(WORKING, {
    type: 'approval/asked',
    data: { id: 'a1', toolName: 'bash' },
  }), INPUT);
  assert.equal(reduceSession(INPUT, {
    type: 'approval/decided',
    data: { id: 'a1' },
  }), WORKING);
});

test('reduceSession: command/run -> working, turn/end -> idle', () => {
  assert.equal(reduceSession(IDLE, { type: 'command/run', data: { line: '/goal' } }), WORKING);
  assert.equal(reduceSession(WORKING, { type: 'turn/end', data: { turn: 1, reason: { kind: 'complete' } } }), IDLE);
});

test('reduceSession: session/end-seed -> null (stop tracking)', () => {
  assert.equal(reduceSession(IDLE, { type: 'session/end-seed' }), null);
});

test('reduceSession: unknown events leave state unchanged', () => {
  for (const type of ['assistant/chunk', 'tool/result', 'step/end', 'user/message', 'session/title']) {
    assert.equal(reduceSession(WORKING, { type, data: {} }), WORKING, type);
  }
  assert.equal(reduceSession(IDLE, { type: 'whatever', data: {} }), IDLE);
});

test('aggregate: highest priority wins', () => {
  assert.equal(aggregate({}), OFF);
  assert.equal(aggregate({ a: IDLE }), IDLE);
  assert.equal(aggregate({ a: WORKING, b: IDLE }), WORKING);
  assert.equal(aggregate({ a: WORKING, b: INPUT }), INPUT);
  assert.equal(aggregate({ a: INPUT, b: WORKING, c: IDLE }), INPUT);
});

test('aggregate: null/unknown states are ignored, empty -> off', () => {
  assert.equal(aggregate({ a: null, b: undefined }), OFF);
  assert.equal(aggregate({ a: 'totally-unknown' }), OFF);
  assert.equal(aggregate({ a: IDLE, b: null }), IDLE);
});

test('aggregate: custom priority order', () => {
  const custom = [WORKING, INPUT, IDLE, OFF];
  assert.equal(aggregate({ a: INPUT, b: WORKING }, custom), WORKING);
});

test('aggregate: default priority is input > working > idle > off', () => {
  assert.deepEqual(DEFAULT_PRIORITY, ['input', 'working', 'idle', 'off']);
});

test('full conversation sequence drives the expected lamp states', () => {
  let state = OFF;
  const events = [
    ['agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ source: { kind: 'user' } }] }],
    ['turn/start', { turn: 1 }],
    ['step/start', { turn: 1, step: 1 }],
    ['tool/call', { turn: 1, step: 1, name: 'web_search' }],
    ['tool/result', { turn: 1, step: 1 }],
    ['approval/asked', { id: 'a', toolName: 'bash' }],
    ['approval/decided', { id: 'a' }],
    ['step/end', { turn: 1, step: 1 }],
    ['turn/end', { turn: 1, reason: { kind: 'complete' } }],
  ];
  const expected = [WORKING, WORKING, WORKING, WORKING, WORKING, INPUT, WORKING, WORKING, IDLE];
  events.forEach(([type, data], index) => {
    state = reduceSession(state, { type, data });
    assert.equal(state, expected[index], `step ${index} (${type})`);
  });
  assert.equal(state, IDLE);
});
