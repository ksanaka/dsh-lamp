/**
 * dsh-lamp backend abstraction.
 *
 * A backend turns per-session lamp contributions into real-world output:
 *
 *   ksanaka — feed the installed ksanaka codex-lamp StateStore (its daemon
 *             aggregates across sessions and drives the lamp over BLE);
 *   loopbrew — aggregate locally and write the loopbrew state file
 *             (/tmp/codex_lamp_state) the loopbrew daemon watches;
 *   none     — log-only (used by dryRun / explicit opt-out).
 *
 * The plugin calls set/clear per session; backends decide how to materialize.
 */

import { aggregate, STATES } from './state.js';
import { writeStateFile, ensureDaemon as ensureLoopbrewDaemon } from './daemon.js';
import { createKsanakaClient, ksanakaAvailable, resolveKsanakaHome } from './ksanaka.js';

/** Resolve the backend kind from config ('auto' picks the installed one). */
export function resolveBackendKind(cfg) {
  if (cfg.dryRun) return 'none';
  const wanted = cfg.backend ?? 'auto';
  if (wanted === 'none' || wanted === 'ksanaka' || wanted === 'loopbrew') return wanted;
  // auto: prefer the installed ksanaka codex-lamp when present.
  if (ksanakaAvailable(resolveKsanakaHome(cfg.ksanaka))) return 'ksanaka';
  return 'loopbrew';
}

export function createBackend(cfg, logger) {
  const kind = resolveBackendKind(cfg);

  if (kind === 'none') {
    return { kind, set() {}, clear() {}, ensureDaemon() {}, dispose() {} };
  }

  if (kind === 'ksanaka') {
    const client = createKsanakaClient(cfg.ksanaka, logger);
    return {
      kind,
      set: (sessionId, state) => client.update(sessionId, state),
      clear: (sessionId) => client.remove(sessionId),
      ensureDaemon: () => client.ensureDaemon(),
      dispose() {},
    };
  }

  // loopbrew: aggregate locally, write the state file, keep the daemon alive.
  const states = new Map(); // sessionId -> state
  const stateFile = cfg.stateFile || process.env.CODEX_LAMP_STATE_FILE || '/tmp/codex_lamp_state';
  const write = () => {
    try {
      const overall = aggregate(Object.fromEntries(states), cfg.priority);
      writeStateFile(stateFile, overall);
      if (overall !== STATES.OFF) ensureLoopbrewDaemon(cfg.daemon, logger);
    } catch (error) {
      logger?.warn?.(`[dsh-lamp] failed to write state file ${stateFile}: ${String(error)}`);
    }
  };
  return {
    kind,
    set: (sessionId, state) => {
      states.set(sessionId, state);
      write();
    },
    clear: (sessionId) => {
      states.delete(sessionId);
      write();
    },
    ensureDaemon: () => ensureLoopbrewDaemon(cfg.daemon, logger),
    dispose() {},
  };
}
