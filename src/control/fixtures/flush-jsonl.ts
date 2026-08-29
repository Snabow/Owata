#!/usr/bin/env node
/**
 * Open a ControlStore against stateDir (triggers JSONL flush) then exit.
 * Usage: node dist/control/fixtures/flush-jsonl.js <stateDir>
 */
import { ControlStore } from "../store.js";

const stateDir = process.argv[2];
if (!stateDir) {
  process.stderr.write("stateDir required\n");
  process.exit(2);
}

const store = ControlStore.open({ stateDir });
const n = store.flushEventJsonl();
store.close();
process.stdout.write(`FLUSHED ${n}\n`);
process.exit(0);
