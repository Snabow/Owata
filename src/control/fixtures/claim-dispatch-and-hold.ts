#!/usr/bin/env node
/**
 * Claim the current cycle dispatch, announce fence, then hold until killed.
 * Usage: node dist/control/fixtures/claim-dispatch-and-hold.js <stateDir> <cycleId> <owner> <leaseMs>
 */
import { ControlStore } from "../store.js";
import { Dispatcher } from "../dispatcher.js";
import { HandoffStore } from "../handoff.js";
import {
  FakeBuilderAdapter,
  FakeProgramControlAdapter,
  FakeReviewerAdapter,
} from "./fake-adapters.js";

const stateDir = process.argv[2];
const cycleId = process.argv[3];
const owner = process.argv[4] ?? "fixture-owner";
const leaseMs = Number(process.argv[5] ?? "60000");

if (!stateDir || !cycleId) {
  process.stderr.write("stateDir and cycleId required\n");
  process.exit(2);
}

const store = ControlStore.open({ stateDir });
const handoff = new HandoffStore(store);
handoff.recoverExpiredDispatches();
const clock = {
  id: (prefix?: string) => store.nextId(prefix),
  now: () => store.now().toISOString(),
};
const dispatcher = new Dispatcher(
  handoff,
  {
    programControl: new FakeProgramControlAdapter([], clock),
    builder: new FakeBuilderAdapter([], clock),
    reviewer: new FakeReviewerAdapter([], clock),
  },
  { owner, leaseMs },
);
const claimed = dispatcher.claimCurrent(cycleId);
process.stdout.write(
  `CLAIMED ${claimed.request_id} ${claimed.fence_token} ${claimed.attempt_number} ${claimed.dispatch_id}\n`,
);
process.stdout.write("HOLDING\n");
setInterval(() => {}, 1000);
