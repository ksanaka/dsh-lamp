#!/usr/bin/env node
/**
 * dsh-lamp demo / verification driver.
 *
 * Applies the real plugin against a scripted conversation timeline and prints
 * the observable lamp state after every step, so you can verify the whole
 * pipeline — event -> state machine -> backend (-> ksanaka StateStore /
 * loopbrew state file -> daemon -> lamp) — without restarting dsh web.
 *
 * Usage:
 *   node scripts/demo.mjs [--backend auto|ksanaka|loopbrew|none]
 *                         [--state-file PATH] [--daemon PATH] [--ksanaka-home PATH]
 *                         [--delay MS]
 *
 *   --backend       backend to exercise (default: auto — ksanaka when its
 *                   install is detected on this machine)
 *   --state-file    loopbrew backend: state file to write
 *                   (default $CODEX_LAMP_STATE_FILE or /tmp/codex_lamp_state)
 *   --daemon        loopbrew backend: path to codex_lamp_daemon.py
 *   --ksanaka-home  ksanaka backend: data root (default $CODEX_LAMP_HOME or
 *                   ~/Library/Application Support/CodexLamp)
 *   --ksanaka-python ksanaka backend: interpreter with codex_lamp installed
 *                   (default <home>/venv/bin/python3)
 *   --delay         pause between steps in ms (default 250)
 *   --hold          ms to wait for the daemon to connect to the lamp before
 *                   the timeline starts (default 9000; cold-started daemons
 *                   need ~6s for the BLE scan+connect, and the timeline must
 *                   not finish before the daemon is listening)
 *
 * With the ksanaka backend on a machine that has codex-lamp installed and a
 * powered Moonside lamp, this actually drives the lamp through the timeline.
 * Exit code is non-zero when any step's observable state does not match.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';
import { STATES } from '../lib/state.js';
import { defaultStateFile } from '../lib/daemon.js';
import { resolveKsanakaHome } from '../lib/ksanaka.js';

const { OFF, IDLE, WORKING, INPUT } = STATES;

function usage() {
  console.log(`Usage: node scripts/demo.mjs [--backend auto|ksanaka|loopbrew|none]
                          [--state-file PATH] [--daemon PATH] [--ksanaka-home PATH]
                          [--delay MS]

  --backend       backend to exercise (default: auto — ksanaka when detected)
  --state-file    loopbrew: state file (default: ${defaultStateFile()})
  --daemon        loopbrew: codex_lamp_daemon.py path (starts it if not running)
  --ksanaka-home  ksanaka: data root (default: ${resolveKsanakaHome()})
  --delay         pause between steps in ms (default 250)
`);
}

function parseArgs(argv) {
  const args = {
    backend: 'auto',
    stateFile: defaultStateFile(),
    daemon: null,
    ksanakaHome: null,
    ksanakaPython: null,
    delayMs: 250,
    holdMs: 9000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--backend') args.backend = argv[++i];
    else if (arg === '--state-file') args.stateFile = argv[++i];
    else if (arg === '--daemon') args.daemon = argv[++i];
    else if (arg === '--ksanaka-home') args.ksanakaHome = argv[++i];
    else if (arg === '--ksanaka-python') args.ksanakaPython = argv[++i];
    else if (arg === '--delay') args.delayMs = Number(argv[++i]);
    else if (arg === '--hold') args.holdMs = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    else { console.error(`unknown argument: ${arg}`); usage(); process.exit(2); }
  }
  return args;
}

/** Minimal Cordis-like context (same shape the unit tests use). */
function fakeCtx() {
  const handlers = new Map();
  return {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    emit(name, ...args) {
      for (const handler of handlers.get(name) ?? []) handler(...args);
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll the observable until it reaches `expected` (bounded). */
async function waitFor(read, expected, timeoutMs = 3000, stepMs = 60) {
  const deadline = Date.now() + timeoutMs;
  let actual = read();
  while (actual !== expected && Date.now() < deadline) {
    await sleep(stepMs);
    actual = read();
  }
  return actual;
}

/**
 * Wait until the ksanaka daemon has connected to the lamp. A cold-started
 * daemon needs ~6s for the BLE scan + connect; the timeline must not finish
 * before then or the lamp never sees a non-off state (it only catches the
 * final `off`). Polls daemon.pid liveness and the daemon log for the
 * "lamp connected" line. Returns true when connected.
 */
async function waitForDaemon(home, timeoutMs = 30000, stepMs = 500) {
  const pidFile = join(home, 'daemon.pid');
  const logFile = join(home, 'logs', 'daemon.log');
  const pidAlive = () => {
    try {
      const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
      if (!Number.isInteger(pid) || pid <= 0) return false;
      try { process.kill(pid, 0); return true; } catch { return false; }
    } catch { return false; }
  };
  const connected = () => {
    try {
      return readFileSync(logFile, 'utf8').includes('lamp connected');
    } catch { return false; }
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pidAlive() && connected()) return true;
    await sleep(stepMs);
  }
  return pidAlive() && connected();
}

// Scripted conversation across two sessions, covering every mapped state.
// `channel` picks which host event fires: session/event carries `event`;
// session/created / session/disposed carry only the session object.
const timeline = [
  { label: '打开会话 (session/created)                     ', channel: 'session/created', session: { id: 's1' }, expect: IDLE },
  { label: '用户提交提示词 (agent/inbox/spliced)           ', channel: 'session/event', session: { id: 's1' }, event: { type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [{ source: { kind: 'user' } }] } }, expect: WORKING },
  { label: '回合开始 (turn/start)                          ', channel: 'session/event', session: { id: 's1' }, event: { type: 'turn/start', data: { turn: 1 } }, expect: WORKING },
  { label: '并发会话开始 (s2 turn/start)                   ', channel: 'session/event', session: { id: 's2' }, event: { type: 'turn/start', data: { turn: 1 } }, expect: WORKING },
  { label: '工具执行 (tool/call bash)                      ', channel: 'session/event', session: { id: 's1' }, event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } }, expect: WORKING },
  { label: '等待审批 (approval/asked)                      ', channel: 'session/event', session: { id: 's1' }, event: { type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } }, expect: INPUT },
  { label: '审批通过 (approval/decided)                    ', channel: 'session/event', session: { id: 's1' }, event: { type: 'approval/decided', data: { id: 'a1' } }, expect: WORKING },
  { label: 's1 回合结束 (turn/end)，s2 仍在工作 → working  ', channel: 'session/event', session: { id: 's1' }, event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'complete' } } }, expect: WORKING },
  { label: 's2 回合结束 (turn/end) → idle                  ', channel: 'session/event', session: { id: 's2' }, event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'complete' } } }, expect: IDLE },
  { label: '关闭 s1 (session/end-seed)                     ', channel: 'session/event', session: { id: 's1' }, event: { type: 'session/end-seed' }, expect: IDLE },
  { label: '关闭 s2 (session/end-seed) → off               ', channel: 'session/event', session: { id: 's2' }, event: { type: 'session/end-seed' }, expect: OFF },
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ctx = fakeCtx();
  apply(ctx, {
    backend: args.backend,
    stateFile: args.stateFile,
    idleDelayMs: 0,
    sweepMs: 60_000,
    ksanaka: { home: args.ksanakaHome ?? undefined, python: args.ksanakaPython ?? undefined },
    daemon: { autoStart: true, path: args.daemon ?? undefined, pidFile: '/tmp/codex_lamp_daemon.pid' },
  });

  // Observable: loopbrew writes the state file; ksanaka persists
  // effective_state.json under its data root (aggregated by its own daemon).
  const ksanakaHome = args.ksanakaHome || process.env.CODEX_LAMP_HOME
    || join(homedir(), 'Library', 'Application Support', 'CodexLamp');
  const observable = args.backend === 'ksanaka'
    ? join(ksanakaHome, 'effective_state.json')
    : args.stateFile;
  const readObservable = () => {
    try {
      return JSON.parse(readFileSync(observable, 'utf8')).state ?? '(no state)';
    } catch {
      try {
        return readFileSync(observable, 'utf8').trim() || '(empty)';
      } catch {
        return '(no file)';
      }
    }
  };

  console.log(`dsh-lamp demo — backend: ${args.backend} (observable: ${observable})`);
  if (args.backend === 'ksanaka') {
    console.log(`ksanaka home: ${ksanakaHome} — a daemon will be started so the Moonside lamp follows the timeline`);
    console.log(`waiting for the daemon to connect to the lamp (up to ${args.holdMs}ms)...`);
    const connected = await waitForDaemon(ksanakaHome, args.holdMs);
    if (connected) {
      console.log('✓ daemon connected to the lamp — starting timeline');
    } else {
      console.log('⚠ daemon not confirmed connected (BLE off? no lamp?) — continuing store-level verification only');
    }
  } else if (args.backend === 'loopbrew') {
    console.log(args.daemon ? `daemon: ${args.daemon} (auto-started if not running)` : 'daemon: none (state file only)');
  }
  console.log('');

  let failed = 0;
  for (const step of timeline) {
    if (step.channel === 'session/created' || step.channel === 'session/disposed') {
      ctx.emit(step.channel, step.session);
    } else {
      ctx.emit('session/event', step.session, step.event);
    }
    await sleep(args.delayMs);
    const actual = await waitFor(readObservable, step.expect);
    const ok = actual === step.expect;
    if (!ok) failed += 1;
    console.log(`${ok ? '✓' : '✗'} ${step.label}  →  ${actual}${ok ? '' : `  (expected ${step.expect})`}`);
  }

  console.log('');
  if (failed === 0) {
    console.log('全部通过。插件管线（事件 → 状态机 → 后端）工作正常。');
  } else {
    console.log(`${failed} 步未通过。`);
  }

  if (args.backend === 'ksanaka') {
    console.log(`
灯验证：如果 MOONSIDE 灯在旁边，它应该已经按时间线亮过一轮
（idle 橙 → working 蓝白跳动 → input 紫 → … → off）。
daemon 日志: ${join(ksanakaHome, 'logs', 'daemon.log')}
`);
  }

  console.log(`
接下来让真实的 dsh web 宿主驱动这盏灯：
  1. 重启 dsh web（停掉当前实例后重新启动）
  2. 打开会话、发消息，然后观察灯 / ${args.backend === 'ksanaka' ? join(ksanakaHome, 'effective_state.json') : args.stateFile}
  3. 观察宿主日志: grep 'dsh-lamp' <日志>
`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
