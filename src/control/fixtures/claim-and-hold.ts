#!/usr/bin/env node
/**
 * WP-001 worker fixture: claim one work item, announce it, then hold until killed.
 * Usage: node dist/control/fixtures/claim-and-hold.js <stateDir> <workerId> <leaseMs>
 */
import { ControlStore } from "../store.js";

const stateDir = process.argv[2];
const workerId = process.argv[3] ?? "worker-fixture";
const leaseMs = Number(process.argv[4] ?? "60000");

if (!stateDir) {
  process.stderr.write("stateDir required\n");
  process.exit(2);
}

const store = ControlStore.open({ stateDir });
const claimed = store.claimNextWork(workerId, leaseMs);
if (!claimed) {
  process.stdout.write("CLAIMED none\n");
  store.close();
  process.exit(1);
}

process.stdout.write(
  `CLAIMED ${claimed.work_id} ${claimed.lease_token} ${claimed.attempt}\n`,
);
process.stdout.write("HOLDING\n");

// Keep process alive with open DB until parent terminates us.
setInterval(() => {}, 1000);
