import { mkdirSync, existsSync, statSync } from "node:fs";

/**
 * Ensure `stateDir` is usable as an OWATA state directory.
 * Missing path: create it, then verify it is a directory.
 * Existing directory: PASS.
 * Existing non-directory: FAIL.
 * Filesystem errors: FAIL.
 */
export function ensureStateDirectory(stateDir: string): boolean {
  try {
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
    }
    return statSync(stateDir).isDirectory();
  } catch {
    return false;
  }
}
