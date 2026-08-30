# DEC-004-006 — Human Routine Approval Zero

**ID:** DEC-004-006
**Status:** ACCEPTED
**Date:** 2026-08-30
**Scope:** Cross-cutting Program Control policy (project-wide)
**Authority:** Human Directive, 2026-08-30 (recorded by Program Control; OWATA-REQ-0090)
**Sequence note:** DEC-004-* because this Directive was canonicalized during WP-004. The policy applies project-wide, not only to Router work.

Builder MUST NOT originate or expand this policy beyond recording the Human-approved meaning below.

---

## Context

Repository / Charter audit found:

- Genesis Charter's "Human merge" appears in the Before / Human-operated prototype description.
- Genesis target state reduces Human from Message Bus / Operator to Goal Setter + Approver + Exception Handler.
- Charter already limits Human return to meaningful reality/value boundaries (outcome meaning, cost, external publication/deletion/charging/legal impact, irreversible action, authentication/permission Agents cannot perform, high-risk merge).
- DEC-003-001 allows Human involvement only at an intentional Human Gate and does not require routine Git promotion approval.

Therefore routine exact fast-forward approval was an over-conservative Program Control operating practice, not a required canonical safety boundary.

---

## Decision

### Primary objective

**HUMAN_ROUTINE_APPROVAL_ZERO**

Human remains:

- Goal Setter
- Meaningful Approver
- Exception Handler

Human is not:

- Git Operator
- SHA verifier
- schema reviewer
- binding / lease / fence operator
- routine promotion approver

Human Gate MUST NOT be used merely as a "confirm because safe" checkpoint.

### Human Gate triggers

Human approval is required when at least one applies:

- Goal / Requirement / Acceptance Criteria meaning changes
- project scope or deliverable meaning changes
- material cost ceiling or continuing cost increases
- Human credential / authentication / permission / privilege action is required
- Security / Privacy / Legal / Compliance boundary changes
- external publication, external transmission, charging, purchase, deletion, or comparable real-world effect
- irreversible or materially rollback-resistant operation
- destructive operation
- Independent Reviewer returns BLOCK
- Program Control and Independent Reviewer have a semantic conflict that cannot be resolved under existing policy
- existing policy cannot determine one safe next action
- multiple valid choices require Human value judgment
- OWATA Trust Boundary, Approval Policy, or Review Authority changes

Future changes to this Decision / policy semantics require Human approval.

### Routine actions — no Human Gate

When already authorized by existing Goal / WP / Decision and safety predicates, do not request Human approval for:

- exact fast-forward
- force=false main promotion
- promotion of exact reviewed candidate
- normal Builder result promotion after required verification
- Independent Review PASS / READY canonicalization
- evidence-only updates
- deterministic state transitions
- bounded REWORK within existing acceptance criteria
- rollback-capable local operations
- non-destructive Git operations
- policy-authorized Agent dispatch
- checkpoint / manifest / status updates

### Routine promotion predicate

A promotion may execute without Human approval only when Program Control establishes all applicable predicates:

```text
BASE_SHA_MATCH = YES
TARGET_SHA_EXACTLY_REVIEWED = YES
INDEPENDENT_REVIEW = PASS
PROGRAM_CONTROL_ACCEPTANCE = YES
TESTS_REQUIRED_BY_WP = PASS
FORCE = FALSE
DESTRUCTIVE_EFFECT = NO
EXTERNAL_SIDE_EFFECT = NO
SECURITY_SCOPE_EXPANSION = NO
COST_BOUNDARY_CHANGE = NO
ROLLBACK_PATH = AVAILABLE
HUMAN_GATE_TRIGGER = NONE
```

`TESTS_REQUIRED_BY_WP = PASS` may rely on durable Builder verification evidence when the isolated Reviewer explicitly reports test rerun `INFRA_LIMIT` as non-blocking and returns overall PASS / READY with no contradictory finding.

A failed predicate does NOT automatically mean Human Gate. Program Control first chooses retry / repair / re-review / redesign or another safe recoverable action when existing policy makes one safe action unambiguous. Escalate to Human only if a Human Gate trigger actually applies.

### Main promotion

Routine repository promotion is allowed without Human confirmation when the predicate above is satisfied.

In particular:

```text
known main
→ exact independently reviewed candidate
fast-forward only
force=false
PC accepted
required verification passed
rollback available
no Human Gate trigger
```

is a Program Control routine promotion.

Do not present raw SHA selection as a Human decision. Exact SHAs remain durable audit evidence.

### Review / self-hosting safety

This policy MUST NOT weaken:

- Builder / Independent Reviewer separation
- exact candidate identity
- disposable / isolated review boundary
- immutable Reviewer findings
- Program Control adjudication
- regression / deterministic verification
- rollback capability
- candidate self-approval prohibition

OWATA developing OWATA is allowed. Candidate OWATA MUST NOT approve itself. Stable/candidate separation remains required where applicable. Independent Review remains mandatory wherever the WP / Decision requires it.

Builder self-approval is **PROHIBITED**. Candidate self-approval is **PROHIBITED**.

### Reviewer dispositions

| Disposition | Program Control |
| --- | --- |
| PASS / READY | May ACCEPT and routine-promote if predicates pass |
| REWORK | Adjudicates findings; may issue bounded REWORK without Human if no Human Gate trigger applies |
| BLOCK | Human Gate required |

Builder never repairs Reviewer findings before Program Control adjudication.

### Human-facing output

Normal Human-facing progress should emphasize only: what is happening, what completed, whether a problem exists, whether Human judgment is required, and if required the meaningful Goal / Risk / Cost / Reality decision.

Do not normally ask Human to judge: SHA, schema version, binding identity, lease/fence mechanics, routine exact fast-forward. These remain audit / evidence details.

---

## Non-goals

Do NOT:

- create "Human Approval Zero" (eliminate meaningful Human Gates)
- remove meaningful Human Gates
- weaken Independent Review
- permit force push by this policy
- permit destructive promotion
- permit external deployment / publication / purchase / deletion automatically
- allow Builder self-approval
- allow candidate self-approval
- implement a generalized approval framework
- change Router S5 semantics
- change provider / model policy

---

## Relation to WP-004-S5

OWATA-REQ-0089 S5 implementation remains:

**IMPLEMENTATION_SHA:** `c95fb633366ab78fa2a33aa3343faf59cf01d1a3`

S5 candidate before this policy Decision: `2e0e48c18daee1ce8bc8b79c0bf7bc555c38cfde`

**S5_ACCEPTED:** NO
**WP004_DONE:** NO

This policy Decision is included in the Independent Review target together with S5. Do not edit DEC-004-005 solely to duplicate this policy.

---

## Source of Truth

Human Directive (2026-08-30) via Program Control OWATA-REQ-0090.
