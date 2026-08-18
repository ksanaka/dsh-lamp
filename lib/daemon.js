/**
 * dsh-lamp I/O helpers — state-file writing and codex-lamp daemon liveness.
 *
 * The on-disk contract matches loopbrew/codex-lamp's `codex_lamp_daemon.py`:
 *   - a plain-text state file (default /tmp/codex_lamp_state, overridable via
 *     CODEX_LAMP_STATE_FILE) holding one of `working|idle|input|off`;
 *   - a pid file (default /tmp/codex_lamp_daemon.pid) the daemon rewrites with
 *     its own pid on startup.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Default state file path (same default as the codex-lamp daemon). */
export function defaultStateFile() {
  return process.env.CODEX_LAMP_STATE_FILE || '/tmp/codex_lamp_state';
}

/** Candidate locations for the codex-lamp BLE daemon (loopbrew layout). */
export function daemonCandidates() {
  return [
    join(homedir(), '.codex', 'codex-lamp', 'codex_lamp_daemon.py'),
  ];
}

/** Resolve the daemon script path: explicit config > env > well-known paths. */
export function resolveDaemonPath(config = {}) {
  if (config.path) return config.path;
  if (process.env.CODEX_LAMP_DAEMON) return process.env.CODEX_LAMP_DAEMON;
  return daemonCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

/** Atomically write the state file (tmp file + rename). */
export function writeStateFile(file, state) {
  const tmp = `${file}.dsh-lamp.tmp`;
  writeFileSync(tmp, `${state}\n`, 'utf8');
  renameSync(tmp, file);
}

/** Whether a live process holds the pid file. */
export function daemonRunning(pidFile) {
  try {
    const raw = readFileSync(pidFile, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * Start the codex-lamp daemon if it is not already running and a daemon
 * script can be located. Never throws: a missing daemon or a failed spawn
 * must not disturb the harness (the state file is still written).
 */
export function ensureDaemon(config = {}, logger) {
  if (config.autoStart === false) return;
  const pidFile = config.pidFile || '/tmp/codex_lamp_daemon.pid';
  if (daemonRunning(pidFile)) return;
  const daemon = resolveDaemonPath(config);
  if (!daemon) {
    // Info level on purpose: a fresh install without any codex-lamp daemon
    // must know the lamp half is missing, even though the state file is fine.
    logger?.info?.('[dsh-lamp] no codex-lamp daemon found; writing state file only (no lamp output)');
    return;
  }
  const python = config.python || process.env.CODEX_LAMP_PYTHON || 'python3';
  try {
    const child = spawn(python, [daemon], { detached: true, stdio: 'ignore' });
    child.unref();
    // The daemon rewrites the pid file with its own pid on startup; writing
    // ours first closes the spawn race so we never double-start it.
    writeFileSync(pidFile, String(child.pid), 'utf8');
    logger?.info?.(`[dsh-lamp] started codex-lamp daemon (pid ${child.pid})`);
  } catch (error) {
    logger?.warn?.(`[dsh-lamp] failed to start codex-lamp daemon: ${String(error)}`);
  }
}
