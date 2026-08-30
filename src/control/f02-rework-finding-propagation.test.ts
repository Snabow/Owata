import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ControlStore,
  Dispatcher,
  HandoffStore,
} from "./index.js";
import type { PcDecisionBody } from "./protocol.js";
import {
  FakeBuilderAdapter,
  FakeProgramControlAdapter,
  FakeReviewerAdapter,
} from "./fixtures/fake-adapters.js";

function seqIds(): (prefix?: string) => string {
  let n = 0;
  return (prefix?: string) => `${prefix ?? "id"}_${++n}`;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function pcDecision(
  partial: Partial<PcDecisionBody> & Pick<PcDecisionBody, "decision">,
): PcDecisionBody {
  return {
    rationale: null,
    authorized_finding_ids: [],
    rework_scope: null,
    human_gate_purpose: null,
    human_gate_choices: null,
    install_policy: null,
    ...partial,
  };
}

test("F02: auto-review after REWORK carries authorized_finding_ids", async () => {
  const dir = mkdtempSync(join(tmpdir(), "owata-f02-rework-ids-"));
  try {
    const store = ControlStore.open({ stateDir: dir, idFactory: seqIds() });
    const handoff = new HandoffStore(store);
    const envClock = {
      id: (prefix?: string) => store.nextId(prefix),
      now: () => store.now().toISOString(),
    };
    const project = store.createProject("f02");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
      baseSha: "base000000000000000000000000000000000000",
    });

    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: new FakeProgramControlAdapter(
          [
            pcDecision({
              decision: "BUILD",
              install_policy: { on_builder_candidate: "DISPATCH_REVIEW" },
            }),
            pcDecision({
              decision: "REWORK",
              authorized_finding_ids: ["F-STATUS-001"],
              rework_scope: "STATUS.md",
            }),
            pcDecision({ decision: "ACCEPT" }),
          ],
          envClock,
        ),
        builder: new FakeBuilderAdapter(
          [
            {
              status: "CANDIDATE_READY",
              candidate_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
            {
              status: "CANDIDATE_READY",
              candidate_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            },
          ],
          envClock,
        ),
        reviewer: new FakeReviewerAdapter(
          [
            {
              verdict: "REWORK",
              findings: [
                {
                  finding_id: "F-STATUS-001",
                  severity: "major",
                  summary: "STATUS broken",
                },
              ],
            },
            { verdict: "PASS", findings: [] },
          ],
          envClock,
        ),
      },
      { owner: "f02", leaseMs: 60_000 },
    );

    // Through first review REWORK → AWAITING_PC
    for (let i = 0; i < 12; i += 1) {
      const live = handoff.requireCycle(cycle.cycle_id);
      if (
        live.state === "AWAITING_PC" &&
        live.latest_candidate_sha ===
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      ) {
        break;
      }
      await dispatcher.step(cycle.cycle_id);
    }
    assert.equal(
      handoff.requireCycle(cycle.cycle_id).latest_candidate_sha,
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );

    // PC REWORK + Builder second candidate + auto-review dispatch
    for (let i = 0; i < 8; i += 1) {
      const live = handoff.requireCycle(cycle.cycle_id);
      if (live.state === "DISPATCHING_REVIEW" && live.latest_candidate_sha ===
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb") {
        break;
      }
      await dispatcher.step(cycle.cycle_id);
    }

    const reviewReqs = handoff
      .listEnvelopes(cycle.cycle_id)
      .filter((e) => e.kind === "control_request")
      .map(
        (e) =>
          e as {
            body: { action: string; authorized_finding_ids: string[] };
          },
      )
      .filter((e) => e.body.action === "REVIEW");
    assert.ok(reviewReqs.length >= 2);
    assert.deepEqual(reviewReqs[0]!.body.authorized_finding_ids, []);
    assert.deepEqual(reviewReqs[1]!.body.authorized_finding_ids, [
      "F-STATUS-001",
    ]);

    store.close();
  } finally {
    cleanup(dir);
  }
});
