#!/usr/bin/env node
/**
 * Concurrent claim worker: try to claim once and print result.
 * Usage: node dist/control/fixtures/claim-once.js <stateDir> <workerId> <leaseMs>
 */
import { ControlStore } from "../store.js";

const stateDir = process.argv[2];
const workerId = process.argv[3] ?? "worker";
const leaseMs = Number(process.argv[4] ?? "5000");

if (!stateDir) {
  process.stderr.write("stateDir required\n");
  process.exit(2);
}

const store = ControlStore.open({ stateDir });
const claimed = store.claimNextWork(workerId, leaseMs);
store.close();
if (!claimed) {
  process.stdout.write("NONE\n");
  process.exit(0);
}
process.stdout.write(`GOT ${claimed.work_id} ${claimed.lease_token}\n`);
process.exit(0);
