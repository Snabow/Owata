#!/usr/bin/env node
/**
 * Claim one work item, optionally pause mid-loop for crash tests, then run loop.
 * Usage:
 *   node dist/worker/fixtures/run-once.js <stateDir> <workerId> <leaseMs> [holdMsBeforeComplete]
 */
import { ControlStore } from "../../control/store.js";
import { runOwnedWork } from "../loop.js";

const stateDir = process.argv[2];
const workerId = process.argv[3] ?? "worker-1";
const leaseMs = Number(process.argv[4] ?? "60000");
const holdMs = Number(process.argv[5] ?? "0");

if (!stateDir) {
  process.stderr.write("stateDir required\n");
  process.exit(2);
}

const store = ControlStore.open({ stateDir });
store.recoverExpiredLeases();
const claimed = store.claimNextWork(workerId, leaseMs);
if (!claimed) {
  process.stdout.write("NONE\n");
  store.close();
  process.exit(0);
}
process.stdout.write(
  `CLAIMED ${claimed.work_id} ${claimed.lease_token} ${claimed.attempt}\n`,
);

if (holdMs > 0) {
  process.stdout.write(`HOLDING ${holdMs}\n`);
  // Stay alive without completing so parent can kill the process.
  setInterval(() => {}, 1000);
} else {
  const result = runOwnedWork(store, claimed);
  process.stdout.write(
    `DONE completed=${result.completed} state=${result.work.state} reason=${result.reason ?? ""}\n`,
  );
  store.close();
  process.exit(result.completed ? 0 : 1);
}
