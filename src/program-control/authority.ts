import { ControlError } from "../control/types.js";
import type { CycleSnapshot } from "../control/adapters.js";
import type {
  CanonicalEnvelope,
  PcDecisionBody,
  ReviewerResultBody,
} from "../control/protocol.js";

export interface AuthorityGuardArgs {
  decision: PcDecisionBody;
  cycle: CycleSnapshot;
  envelopes: CanonicalEnvelope[];
}

function reviewerResultsForCycle(
  envelopes: CanonicalEnvelope[],
  cycleId: string,
): CanonicalEnvelope<ReviewerResultBody>[] {
  return envelopes
    .filter(
      (e): e is CanonicalEnvelope<ReviewerResultBody> =>
        e.kind === "reviewer_result" && e.cycle_id === cycleId,
    )
    .slice()
    .sort((a, b) => {
      const ta = Date.parse(a.created_at);
      const tb = Date.parse(b.created_at);
      if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) {
        return ta - tb;
      }
      return a.envelope_id.localeCompare(b.envelope_id);
    });
}

function latestReviewerForCandidate(
  envelopes: CanonicalEnvelope[],
  cycleId: string,
  candidateSha: string,
): CanonicalEnvelope<ReviewerResultBody> | null {
  const matching = reviewerResultsForCycle(envelopes, cycleId).filter(
    (e) => e.body.target_sha === candidateSha,
  );
  return matching.length > 0 ? matching[matching.length - 1]! : null;
}

/**
 * Deterministic Program Control authority gates before applyDecision.
 * ACCEPT / REWORK only; other decisions pass through unchanged.
 */
export function assertPcDecisionAuthority(args: AuthorityGuardArgs): void {
  const { decision, cycle, envelopes } = args;

  if (decision.decision !== "ACCEPT" && decision.decision !== "REWORK") {
    return;
  }

  const latestCandidate = cycle.latest_candidate_sha;
  if (!latestCandidate) {
    throw new ControlError(
      "RESULT_INVALID",
      `${decision.decision} requires a durable latest_candidate_sha`,
    );
  }

  const latestReview = latestReviewerForCandidate(
    envelopes,
    cycle.cycle_id,
    latestCandidate,
  );
  if (!latestReview) {
    throw new ControlError(
      "RESULT_INVALID",
      `${decision.decision} requires a Reviewer result for latest candidate ${latestCandidate}`,
    );
  }

  // No newer candidate than the reviewed SHA: latest_candidate must equal reviewed target.
  if (latestReview.body.target_sha !== latestCandidate) {
    throw new ControlError(
      "RESULT_INVALID",
      `Reviewer target_sha ${latestReview.body.target_sha} != latest_candidate_sha ${latestCandidate}`,
    );
  }

  // Reject if any Reviewer result exists for a different SHA that is "newer"
  // in envelope order after this review while cycle still points elsewhere —
  // covered by equality check above against cycle.latest_candidate_sha.

  if (decision.decision === "ACCEPT") {
    if (latestReview.body.verdict !== "PASS") {
      throw new ControlError(
        "RESULT_INVALID",
        `ACCEPT requires latest Reviewer PASS for ${latestCandidate}, got ${latestReview.body.verdict}`,
      );
    }
    // Unresolved REWORK/BLOCK: any later review on same candidate must not
    // leave REWORK/BLOCK as the latest; we already took latest for candidate.
    // Also reject if a globally later review on another SHA exists while
    // latest_candidate still points at an older SHA — impossible given equality.
    const allLater = reviewerResultsForCycle(envelopes, cycle.cycle_id).filter(
      (e) => {
        const ta = Date.parse(e.created_at);
        const tb = Date.parse(latestReview.created_at);
        if (Number.isFinite(ta) && Number.isFinite(tb)) {
          return ta > tb;
        }
        return e.envelope_id > latestReview.envelope_id;
      },
    );
    for (const later of allLater) {
      if (
        later.body.target_sha === latestCandidate &&
        (later.body.verdict === "REWORK" || later.body.verdict === "BLOCK")
      ) {
        throw new ControlError(
          "RESULT_INVALID",
          `ACCEPT blocked by unresolved ${later.body.verdict} after PASS`,
        );
      }
      if (later.body.target_sha !== latestCandidate) {
        throw new ControlError(
          "RESULT_INVALID",
          `ACCEPT blocked: newer Reviewer result targets ${later.body.target_sha} while latest_candidate is ${latestCandidate}`,
        );
      }
    }
    return;
  }

  // REWORK
  if (latestReview.body.verdict !== "REWORK") {
    throw new ControlError(
      "RESULT_INVALID",
      `REWORK requires latest Reviewer REWORK for ${latestCandidate}, got ${latestReview.body.verdict}`,
    );
  }
  if (decision.authorized_finding_ids.length === 0) {
    throw new ControlError(
      "RESULT_INVALID",
      "REWORK requires non-empty authorized_finding_ids",
    );
  }
  const allowed = new Set(
    latestReview.body.findings.map((f) => f.finding_id),
  );
  for (const id of decision.authorized_finding_ids) {
    if (!allowed.has(id)) {
      throw new ControlError(
        "RESULT_INVALID",
        `authorized_finding_id not on latest Reviewer REWORK (invented/stale): ${id}`,
      );
    }
  }
}
