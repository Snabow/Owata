import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ControlStore, dbPath, HandoffStore } from "./control/index.js";
import type { CycleState } from "./control/protocol.js";
import { ControlError } from "./control/types.js";

export type NextAuthority =
  | "program_control"
  | "builder"
  | "reviewer"
  | "human"
  | "none";

export type StatusSnapshot =
  | {
      kind: "ABSENT";
      stateDir: string;
      statusCode: "NO_DURABLE_STATE";
    }
  | {
      kind: "PRESENT";
      stateDir: string;
      projectName: string | null;
      projectId: string | null;
      cycleId: string | null;
      workPackageRef: string | null;
      cycleState: CycleState | null;
      currentRequestId: string | null;
      latestCandidateSha: string | null;
      acceptedCandidateSha: string | null;
      recoveryReason: string | null;
      nextAuthority: NextAuthority;
    };

export function nextAuthorityForCycleState(
  state: CycleState | null,
): NextAuthority {
  if (state == null) return "program_control";
  switch (state) {
    case "AWAITING_PC":
    case "DISPATCHING_PC":
    case "RECOVERY_REQUIRED":
      return "program_control";
    case "DISPATCHING_BUILD":
      return "builder";
    case "DISPATCHING_REVIEW":
      return "reviewer";
    case "HUMAN_GATE":
      return "human";
    case "ACCEPTED":
    case "ABORTED":
      return "none";
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

/**
 * Read-only status snapshot from existing SQLite control state.
 * Does not create control.sqlite / WAL / events.jsonl when absent.
 */
export function readStatusSnapshot(stateDir: string): StatusSnapshot {
  const resolved = resolve(stateDir);
  const sqlitePath = dbPath(resolved);
  if (!existsSync(sqlitePath)) {
    return {
      kind: "ABSENT",
      stateDir: resolved,
      statusCode: "NO_DURABLE_STATE",
    };
  }

  let store: ControlStore;
  try {
    store = ControlStore.open({ stateDir: resolved });
  } catch (err) {
    if (err instanceof ControlError) throw err;
    throw new ControlError(
      "STATE_DIR",
      `Failed to open durable control state: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  try {
    const handoff = new HandoffStore(store);
    const cycles = handoff.listCyclesNewestFirst();
    if (cycles.length > 0) {
      const cycle = cycles[0]!;
      const project = store.getProject(cycle.project_id);
      return {
        kind: "PRESENT",
        stateDir: resolved,
        projectName: project?.name ?? null,
        projectId: cycle.project_id,
        cycleId: cycle.cycle_id,
        workPackageRef: cycle.work_package_ref,
        cycleState: cycle.state,
        currentRequestId: cycle.current_request_id,
        latestCandidateSha: cycle.latest_candidate_sha,
        acceptedCandidateSha: cycle.accepted_candidate_sha,
        recoveryReason: cycle.recovery_reason,
        nextAuthority: nextAuthorityForCycleState(cycle.state),
      };
    }

    const projects = store.listProjectsNewestFirst();
    if (projects.length > 0) {
      const project = projects[0]!;
      return {
        kind: "PRESENT",
        stateDir: resolved,
        projectName: project.name,
        projectId: project.project_id,
        cycleId: null,
        workPackageRef: null,
        cycleState: null,
        currentRequestId: null,
        latestCandidateSha: null,
        acceptedCandidateSha: null,
        recoveryReason: null,
        nextAuthority: "program_control",
      };
    }

    return {
      kind: "PRESENT",
      stateDir: resolved,
      projectName: null,
      projectId: null,
      cycleId: null,
      workPackageRef: null,
      cycleState: null,
      currentRequestId: null,
      latestCandidateSha: null,
      acceptedCandidateSha: null,
      recoveryReason: null,
      nextAuthority: "program_control",
    };
  } finally {
    store.close();
  }
}

export function formatStatus(snapshot: StatusSnapshot): string {
  if (snapshot.kind === "ABSENT") {
    return [
      "Project: OWATA",
      "Durable state: ABSENT",
      `State directory: ${snapshot.stateDir}`,
      "Latest cycle: none",
      "Next authority: program_control",
      `Status: ${snapshot.statusCode}`,
      "",
    ].join("\n");
  }

  const projectLine =
    snapshot.projectName != null && snapshot.projectId != null
      ? `Project: ${snapshot.projectName} (${snapshot.projectId})`
      : snapshot.projectId != null
        ? `Project: (${snapshot.projectId})`
        : "Project: none";

  return [
    projectLine,
    "Durable state: PRESENT",
    `State directory: ${snapshot.stateDir}`,
    `Latest cycle: ${snapshot.cycleId ?? "none"}`,
    `Work Package: ${snapshot.workPackageRef ?? "none"}`,
    `Cycle state: ${snapshot.cycleState ?? "none"}`,
    `Current request: ${snapshot.currentRequestId ?? "none"}`,
    `Latest candidate: ${snapshot.latestCandidateSha ?? "none"}`,
    `Accepted candidate: ${snapshot.acceptedCandidateSha ?? "none"}`,
    `Recovery: ${snapshot.recoveryReason ?? "none"}`,
    `Next authority: ${snapshot.nextAuthority}`,
    "",
  ].join("\n");
}
