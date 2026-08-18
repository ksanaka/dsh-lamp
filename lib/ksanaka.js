/**
 * dsh-lamp ksanaka backend — drives the *installed* ksanaka codex-lamp
 * (github.com/ksanaka/codex-lamp) through its own StateStore, so its BLE
 * daemon drives the lamp with zero protocol reimplementation.
 *
 * The bridge (`python/ksanaka_bridge.py`) runs under the codex-lamp venv
 * python, where `import codex_lamp` resolves to the installed package. All
 * failure modes are fail-open: a missing install, a dead venv, or a failed
 * spawn only logs a warning.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** ksanaka's default data root on macOS (CODEX_LAMP_HOME when unset). */
const DEFAULT_KSANAKA_HOME = join(homedir(), 'Library', 'Application Support', 'CodexLamp');

/** Resolve the ksanaka data root: explicit config > CODEX_LAMP_HOME > default. */
export function resolveKsanakaHome(config = {}) {
  if (config.home) return config.home;
  if (process.env.CODEX_LAMP_HOME) return process.env.CODEX_LAMP_HOME;
  return DEFAULT_KSANAKA_HOME;
}

/** Resolve the interpreter that has `codex_lamp` installed (the venv). */
export function resolveKsanakaPython(home, config = {}) {
  if (config.python) return config.python;
  const venv = join(home, 'venv', 'bin', 'python3');
  return existsSync(venv) ? venv : 'python3';
}

/** Whether a ksanaka install looks present at `home`. */
export function ksanakaAvailable(home) {
  return existsSync(join(home, 'config.json')) || existsSync(join(home, 'sessions'));
}

/** Whether the daemon pid file points at a live process. */
export function ksanakaDaemonAlive(home) {
  try {
    const raw = readFileSync(join(home, 'daemon.pid'), 'utf8').trim();
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
 * Create a serialized bridge client. Bridge calls are queued so update/remove
 * for the same session keep their order (the StateStore itself also flocks,
 * so this is belt-and-braces).
 */
export function createKsanakaClient(config = {}, logger) {
  const home = resolveKsanakaHome(config);
  const python = resolveKsanakaPython(home, config);
  const bridgePath = fileURLToPath(new URL('../python/ksanaka_bridge.py', import.meta.url));
  let queue = Promise.resolve();

  const run = (args) => {
    const task = queue.then(() => new Promise((resolve) => {
      const child = spawn(python, [bridgePath, '--home', home, ...args], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => {
        logger?.warn?.(`[dsh-lamp] ksanaka bridge spawn failed: ${String(error)}`);
        resolve();
      });
      child.on('close', (code) => {
        if (code !== 0) {
          logger?.warn?.(`[dsh-lamp] ksanaka bridge exited ${code}: ${stderr.trim()}`);
        }
        resolve();
      });
    }));
    queue = task;
    return task;
  };

  return {
    home,
    python,
    update: (sessionId, state) => run(['update', sessionId, state]),
    remove: (sessionId) => run(['remove', sessionId]),
    /** Start the daemon if its pid file is stale/absent (daemon.lock dedupes). */
    ensureDaemon: () => {
      if (ksanakaDaemonAlive(home)) return;
      try {
        const child = spawn(python, ['-m', 'codex_lamp.daemon'], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, CODEX_LAMP_HOME: home },
        });
        child.unref();
        logger?.info?.(`[dsh-lamp] started ksanaka codex-lamp daemon (pid ${child.pid})`);
      } catch (error) {
        logger?.warn?.(`[dsh-lamp] failed to start ksanaka daemon: ${String(error)}`);
      }
    },
  };
}
