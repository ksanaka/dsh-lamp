/**
 * dsh-lamp state-file helpers.
 *
 * The `state-file` backend writes the derived lamp state as a plain-text file
 * holding one of `working|idle|input|off`; any consumer may watch it — a
 * daemon of your own, a shell script, `tail -f`, etc. The path is
 * configurable; the default is /tmp/dsh_lamp_state. Writes are atomic
 * (tmp file + rename) so a reader never sees a half-written line.
 */

import { writeFileSync, renameSync } from 'node:fs';

/** Default state file path (override with $DSH_LAMP_STATE_FILE or config). */
export function defaultStateFile() {
  return process.env.DSH_LAMP_STATE_FILE || '/tmp/dsh_lamp_state';
}

/** Atomically write the state file (tmp file + rename). */
export function writeStateFile(file, state) {
  const tmp = `${file}.dsh-lamp.tmp`;
  writeFileSync(tmp, `${state}\n`, 'utf8');
  renameSync(tmp, file);
}
