import { ControlError } from "../control/types.js";

export const B2_S2_CANARY_BUDGET = {
  PC_MAX: 3,
  BUILDER_MAX: 2,
  REVIEWER_MAX: 2,
  TOTAL_MAX: 7,
} as const;

export type CanaryBudgetRole = "program_control" | "builder" | "reviewer";

/**
 * Canary-only hard pre-spawn invocation budget (OWATA-0055-PC-F03).
 * Not a product Model Router / global quota.
 */
export class B2FullCanaryInvocationBudget {
  private counts = {
    program_control: 0,
    builder: 0,
    reviewer: 0,
  };

  snapshot(): {
    program_control: number;
    builder: number;
    reviewer: number;
    total: number;
  } {
    const total =
      this.counts.program_control +
      this.counts.builder +
      this.counts.reviewer;
    return { ...this.counts, total };
  }

  /**
   * Call immediately before an external semantic spawn.
   * Throws ControlError CANARY_INVOCATION_BUDGET_EXCEEDED if over budget.
   */
  consume(role: CanaryBudgetRole): void {
    const next = { ...this.counts, [role]: this.counts[role] + 1 };
    const total =
      next.program_control + next.builder + next.reviewer;
    const roleMax =
      role === "program_control"
        ? B2_S2_CANARY_BUDGET.PC_MAX
        : role === "builder"
          ? B2_S2_CANARY_BUDGET.BUILDER_MAX
          : B2_S2_CANARY_BUDGET.REVIEWER_MAX;
    if (next[role] > roleMax || total > B2_S2_CANARY_BUDGET.TOTAL_MAX) {
      throw new ControlError(
        "CANARY_INVOCATION_BUDGET_EXCEEDED",
        `B2-S2 canary budget exceeded before ${role} spawn: ` +
          `pc=${next.program_control}/${B2_S2_CANARY_BUDGET.PC_MAX} ` +
          `builder=${next.builder}/${B2_S2_CANARY_BUDGET.BUILDER_MAX} ` +
          `reviewer=${next.reviewer}/${B2_S2_CANARY_BUDGET.REVIEWER_MAX} ` +
          `total=${total}/${B2_S2_CANARY_BUDGET.TOTAL_MAX}`,
      );
    }
    this.counts = next;
  }
}
