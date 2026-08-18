/**
 * dsh-lamp — DeepSeek Harness host plugin.
 *
 * Subscribes to the host's `session/event` stream (the same seam
 * dsh-session-title and dsh-session-telemetry use) and derives a lamp state
 * from live session activity:
 *
 *   working — a turn/step/tool is running, or the user just queued a prompt
 *   input   — the agent is waiting on the user (approval/asked, ask_user_question)
 *   idle    — turns completed; an open session sits idle (also on session open)
 *   off     — no tracked sessions remain, or all records went stale
 *
 * The state is pushed per session to a backend:
 *
 *   - ksanaka (default when its install is detected): feeds the installed
 *     ksanaka codex-lamp StateStore; its BLE daemon drives the Moonside lamp;
 *   - state-file: writes a plain state file (default /tmp/dsh_lamp_state)
 *     for any consumer to watch;
 *   - none: log-only.
 *
 * All failures are fail-open: a broken backend never disturbs the harness.
 */

import { reduceSession, aggregate, DEFAULT_PRIORITY, STATES } from './state.js';
import { createBackend } from './backend.js';

export const name = 'dsh-lamp';

const DEFAULT_CONFIG = {
  // Which backend to use: 'auto' (default) picks ksanaka when its install is
  // detected, else state-file; 'ksanaka' | 'state-file' | 'none' force one.
  backend: 'auto',
  // state-file backend: where the state is written
  // (defaults to $DSH_LAMP_STATE_FILE or /tmp/dsh_lamp_state).
  stateFile: undefined,
  // Priority order for aggregation (first = highest). Mirrored to the
  // state-file backend's aggregate; ksanaka uses its own config.json priority.
  priority: DEFAULT_PRIORITY,
  // Debounce a per-session drop to `idle` by this many ms; a newer event for
  // the same session cancels it (kills working/idle flicker).
  idleDelayMs: 800,
  // Drop a session from tracking after this much inactivity.
  staleMs: 30 * 60 * 1000,
  // How often the staleness sweep runs.
  sweepMs: 60 * 1000,
  // ksanaka backend options.
  ksanaka: {
    home: undefined,   // data root (default $CODEX_LAMP_HOME or ~/Library/Application Support/CodexLamp)
    python: undefined, // interpreter with codex_lamp installed (default <home>/venv/bin/python3)
  },
  dryRun: false,         // log transitions only; never touch any backend
};

export function apply(ctx, config = {}) {
  const cfg = {
    ...DEFAULT_CONFIG,
    ...config,
    ksanaka: { ...DEFAULT_CONFIG.ksanaka, ...(config.ksanaka ?? {}) },
  };
  const backend = createBackend(cfg, ctx.logger);
  const sessions = new Map();   // sessionId -> { state, lastActivity }
  const idleTimers = new Map(); // sessionId -> debounce timeout
  let overall = STATES.OFF;
  let daemonTimer = null;
  let sweep = null;

  const overallOf = () => {
    const states = {};
    for (const [id, record] of sessions) states[id] = record.state;
    return aggregate(states, cfg.priority);
  };

  const logOverall = () => {
    const next = overallOf();
    if (next === overall) return;
    overall = next;
    ctx.logger.info(
      `[dsh-lamp] state -> ${next} (${sessions.size} session(s) tracked, backend: ${backend.kind})`,
    );
  };

  /** Record a session's new state and push it to the backend (idle debounced). */
  const setSession = (id, state) => {
    const record = sessions.get(id);
    const changed = !record || record.state !== state;
    sessions.set(id, { state, lastActivity: Date.now() });
    if (state === STATES.IDLE && changed && cfg.idleDelayMs > 0) {
      // Debounce the idle write; a newer event for this session cancels it.
      if (idleTimers.has(id)) clearTimeout(idleTimers.get(id));
      const timer = setTimeout(() => {
        idleTimers.delete(id);
        backend.set(id, state);
      }, cfg.idleDelayMs);
      timer.unref?.();
      idleTimers.set(id, timer);
    } else {
      if (idleTimers.has(id)) {
        clearTimeout(idleTimers.get(id));
        idleTimers.delete(id);
      }
      if (changed) backend.set(id, state);
    }
    logOverall();
  };

  /** Stop tracking a session and remove its lamp contribution. */
  const clearSession = (id) => {
    sessions.delete(id);
    if (idleTimers.has(id)) {
      clearTimeout(idleTimers.get(id));
      idleTimers.delete(id);
    }
    backend.clear(id);
    logOverall();
  };

  // Live session-log events: the primary driver.
  ctx.on('session/event', (session, event) => {
    const id = session?.id;
    if (id === undefined || id === null) return;
    const current = sessions.get(id)?.state ?? STATES.OFF;
    const next = reduceSession(current, event, cfg.priority);
    if (next === null) clearSession(id);
    else setSession(id, next);
  });

  // A session opened (also fires when restoring/opening an existing one):
  // seed it as idle so the lamp wakes before the first event arrives.
  ctx.on('session/created', (session) => {
    const id = session?.id;
    if (id === undefined || id === null) return;
    if (!sessions.has(id)) setSession(id, STATES.IDLE);
  });

  // A session closed: stop tracking it.
  ctx.on('session/disposed', (session) => {
    const id = session?.id;
    if (id === undefined || id === null) return;
    clearSession(id);
  });

  // Staleness sweep: sessions that emitted nothing for `staleMs` drop out.
  sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, record] of sessions) {
      if (now - record.lastActivity > cfg.staleMs) clearSession(id);
    }
  }, cfg.sweepMs);
  sweep.unref?.();

  // Wake the backend's daemon shortly after boot so the lamp is ready before
  // the first event arrives.
  daemonTimer = setTimeout(() => backend.ensureDaemon(), 1500);
  daemonTimer.unref?.();

  ctx.on('dispose', () => {
    if (daemonTimer !== null) clearTimeout(daemonTimer);
    for (const timer of idleTimers.values()) clearTimeout(timer);
    idleTimers.clear();
    if (sweep !== null) clearInterval(sweep);
    backend.dispose();
  });
}
