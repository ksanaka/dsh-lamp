/**
 * dsh-lamp backend abstraction.
 *
 * A backend turns per-session lamp contributions into real-world output:
 *
 *   ksanaka    — feed the ksanaka codex-lamp StateStore (its BLE daemon
 *                aggregates across sessions and drives the lamp);
 *   state-file — aggregate locally and write a plain state file
 *                (default /tmp/dsh_lamp_state) for any consumer to watch;
 *   none       — log-only (used by dryRun / explicit opt-out).
 *
 * The plugin calls set/clear per session; backends decide how to materialize.
 */

import { aggregate } from './state.js';
import { defaultStateFile, writeStateFile } from './statefile.js';
import { createKsanakaClient, ksanakaAvailable, resolveKsanakaHome } from './ksanaka.js';

/** Resolve the backend kind from config ('auto' picks the installed one). */
export function resolveBackendKind(cfg) {
  if (cfg.dryRun) return 'none';
  const wanted = cfg.backend ?? 'auto';
  if (wanted === 'none' || wanted === 'ksanaka' || wanted === 'state-file') return wanted;
  // auto: prefer the installed ksanaka codex-lamp when present.
  if (ksanakaAvailable(resolveKsanakaHome(cfg.ksanaka))) return 'ksanaka';
  return 'state-file';
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

  // state-file: aggregate locally and write the file atomically. No daemon
  // management — whatever consumes the file is up to the user.
  const states = new Map(); // sessionId -> state
  const stateFile = cfg.stateFile || defaultStateFile();
  const write = () => {
    try {
      const overall = aggregate(Object.fromEntries(states), cfg.priority);
      writeStateFile(stateFile, overall);
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
    ensureDaemon() {},
    dispose() {},
  };
}
