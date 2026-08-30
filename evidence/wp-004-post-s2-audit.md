# WP-004 Post-S2 Remaining Router Audit

**AUDIT_ID:** OWATA-REQ-0080  
**ACTION:** `AUDIT_WP004_POST_S2_REMAINING_ROUTER`  
**AUTHORITATIVE_MAIN / BASE:** `695e15c97ba6d2b020bbc9ca0fd763c83be96b00`  
**BRANCH:** `wp-004/post-s2-router-audit`  
**S1_ACCEPTED:** YES  
**S2_ACCEPTED:** YES  
**WP004_DONE:** NO  
**ACTIVE_RUNTIME_CUTOVER:** NO  
**IMPLEMENTATION:** NONE (audit only)  
**REVIEWER:** NOT_REQUIRED  

---

## Objective

Bounded audit of remaining Phase 4 Router work after S2. Recommend exactly one next implementation slice. Do not implement.

Charter Phase 4 still open after S1/S2: quota, cost, automatic escalation, failover, plus active dispatch integration (explicitly deferred in WP-004).

---

## 1. Quota substrate — ABSENT

No provider-neutral or provider-specific product surface exposes remaining quota, exhausted quota, rate-limit state, reset time, request/token allowance, subscription usage, or usage-window state.

| Concept | Status | Notes |
| --- | --- | --- |
| Provider / plan quota | **ABSENT** | No types/APIs in `src/router/**`, gateways, protocol bodies, or SQLite |
| Cost | **ABSENT** | See §2 |
| Dispatch/repair/canary budgets | EXISTING (not quota) | Retry/repair/canary ceilings only |
| Availability (S2) | EXISTING | Runtime readiness ≠ quota |
| Rate-limit retry timing | **ABSENT** | No `reset_at` / 429 substrate |

### Near-misses (must not be treated as Router quota)

| Symbol | Path | Why not quota |
| --- | --- | --- |
| `B2FullCanaryInvocationBudget` | `src/canary/b2-full-invocation-budget.ts` | Explicit non-product canary spawn caps |
| `dispatch_retry_budget_exhausted` / `RETRY_BUDGET` | `src/control/handoff.ts` | Same-`request_id` attempt ceiling |
| `repair_budget_exhausted` | `src/control/store.ts`, `src/worker/loop.ts` | Worker repair path |
| Registry unknown `cost` | `src/router/router.test.ts` | Rejected; proves static registry has no cost/quota fields |
| Eligibility docstring | `src/router/eligibility.ts` | Explicitly excludes quota |

Do not infer quota from absence of errors. Do not treat unknown quota as zero or unlimited.

---

## 2. Cost substrate — ABSENT

| Envelope | Path | Cost / token / billing fields |
| --- | --- | --- |
| `BuilderResultBody` | `src/control/protocol.ts` | none (`status`, `candidate_sha`, `evidence_refs`, `notes`) |
| `ReviewerResultBody` | same | none |
| `PcDecisionBody` | same | none |
| `ControlRequestBody` | same | no `cost_class` / budget fields |
| Reviewer JSON schema | `src/reviewer/schemas/reviewer-result.schema.json` | `additionalProperties: false`; no usage fields |
| Wait results | execution / reviewer / program-control bindings | exit / stdout / stderr only |

Design-only mentions (not implemented): DEC-003-002 future `cost_class` / budget; Charter Axis A / `unknown cost = 0.0`; entry audit P4-05.

Do not invent price tables. Do not assume subscription marginal cost = 0.

---

## 3. Dispatch integration — ABSENT (critical unlock)

### Where role → concrete runtime happens today

| Layer | Path | Mechanism |
| --- | --- | --- |
| Canary construction | `src/canary/b2-full-no-relay-canary.ts` | Hardcoded `CodexCliProgramControlBinding` / `CursorCliBinding` / `CodexCliBinding` |
| Gateways | `src/program-control/gateway.ts`, `src/execution/gateway.ts`, `src/reviewer/gateway.ts` | Each takes **one** binding; `identity.adapter_id` is gateway-class (`gateway-builder` etc.), **≠** registry `binding_id` |
| Dispatcher | `src/control/dispatcher.ts` | `DispatcherAdapters` triple; `adapterFor(role)`; **no** `src/router` import |
| Registry | `config/provider-registry.json` | Documents Champion IDs; **not loaded** by Dispatcher/canary/gateways |

**Router consumption outside `src/router/**`:** none.

### S1 / S2 APIs available but unwired

- `filterEligibleBindings` — `src/router/eligibility.ts`
- `overlayAvailability` / `normalizeAvailability` / `observeBindingAvailability` — `src/router/availability.ts`
- `loadProviderRegistry` / parse helpers — `src/router/registry.ts`

### Minimum future seam (do not implement in this audit)

```text
loadProviderRegistry → filterEligibleBindings → overlayAvailability → selectFirstAvailableBinding
```

Keep semantic Program Control authority in Dispatcher / `assertPcDecisionAuthority`. Selection must not emit `BUILD` / `REWORK` / `ACCEPT` / `HUMAN_GATE`.

---

## 4. Automatic escalation — ABSENT (deferred)

| Input class | Exists? |
| --- | --- |
| Role + required capabilities | Yes (`ControlRequestBody`, `EligibilityRequest`) |
| Ordered eligible/available set | Partial API (S1/S2); registry currently one Champion per role |
| Difficulty / cost_class | No on requests |
| Prior failure evidence | Partial (`FailureClass`, recovery); no “too weak model” |
| Strength ranking beyond `priority` | No |

| Kind | Who | Location today |
| --- | --- | --- |
| Semantic PC decision | Program Control | `PcDecisionBody` → `assertStrictProgramControlDecision` → `assertPcDecisionAuthority` → `Dispatcher.applyDecision` |
| Router binding choice | Router (future) | Absent — canary hardcodes Champions |
| Recovery after runtime failure | Control Core → PC | `enterRecovery`, retry budget → `RECOVERY_REQUIRED` |
| Stronger provider / model policy | Local only | `src/execution/model-policy.ts` (A-002: remain outside generic Router) |

Escalation ≠ REWORK. Router must never decide BUILD/REWORK/ACCEPT/HUMAN_GATE.

---

## 5. Failover prerequisites

| Prerequisite | Status | Evidence / gap |
| --- | --- | --- |
| Attempt identity | YES | `dispatches.attempt_number` UNIQUE; `dispatch_id`; worker `attempt_id` |
| Fencing | YES | `fence_token`; stale → `RESULT_STALE` / `STALE_FENCE` |
| Idempotency | PARTIAL | `ALREADY_ACCEPTED`; `canonicalEnvelopeIdentity`; no alternate-binding key |
| Cancellation | PARTIAL | Binding `cancel`; lease heartbeat AbortSignal; no auto-failover |
| Exact binding identity on dispatch | **NO** | `dispatches` has no `binding_id`; `adapter_id` ≠ registry `binding_id` |
| Retry lineage | YES (semantic) | `recovery_lineage_id`, `retry_of_request_id` — PC recovery, not binding failover |

Failover under fencing is blocked until selection exists and selected `binding_id` is durably attributable.

---

## 6. Quota model design check

A safe generic numeric quota model cannot be defined honestly today: there is no observation substrate and provider units are not comparable. Prefer deferring quota until:

1. a selection pipeline exists to apply observations, and  
2. either honest coarse states (`AVAILABLE` / `EXHAUSTED` / `UNKNOWN`) with adapter-owned probes, or an explicit provider-adapter boundary — not false numeric normalization.

Do not encode Claude/non-Claude restrictions as capability, quota, cost, registry tag, or universal Router exclusion (A-002).

---

## 7. Durability

| Concern | Recommendation for next slice |
| --- | --- |
| Point-in-time observation authority | Ephemeral in-memory (same as S2) |
| Durable routing decision evidence | Deferred until cutover / failover |
| SQLite schema change in next slice | **NO** — not required for acceptance |

---

## Dependency order (evidence-driven)

1. **Deterministic binding selection** over S1∩S2 (unlocks consumption of what already exists)  
2. Later: active cutover (+ FailureClass mapping; optional durable `binding_id`)  
3. Later: quota and/or cost observation contracts (need selection to apply; substrate currently ABSENT)  
4. Later: automatic escalation (needs multi-binding ranking + policy inputs)  
5. Later: failover under fencing (needs selection + durable binding identity)

Charter bullet order (quota before cost before escalation before failover) is **not** followed here because repository evidence shows selection is the missing prerequisite for all of them.

---

## Recommended next slice

### WP-004-S3 — Deterministic binding selection from S1∩S2 (API-only; no active cutover)

**In scope:** pure `selectBinding` (or equivalent) composing eligibility + availability → `SELECTED` | `NO_ELIGIBLE_BINDING` | `NO_AVAILABLE_BINDING`; unit tests; Decision for A-004/A-005 defaults.

**Out of scope:** Dispatcher/canary cutover; quota; cost; escalation; failover; SQLite; model-policy embed; real invocations.

### S3 success criterion (machine-checkable)

Given a validated `ProviderRegistry`, an `EligibilityRequest` `{ role, requiredCapabilities }`, and a unique-per-`binding_id` availability observation list, the system returns either `{ status: "SELECTED", binding }` equal to the first `AVAILABLE` binding in S1 eligibility order, or `NO_ELIGIBLE_BINDING` / `NO_AVAILABLE_BINDING` as today, without invoking any Gateway/Dispatcher adapter, without writing SQLite, without emitting `BUILD`/`REWORK`/`ACCEPT`/`HUMAN_GATE`, and without changing live canary Champion wiring.

---

## Ambiguities (Program Control adjudication)

### A-004 — Single-binding selection rule after S2 overlay

- **Question:** May S3 define `SELECTED = first AVAILABLE in S1 order`, or must Router continue returning only a set until a later cutover Decision?
- **Evidence:** DEC-004-001 A-001 (selection deferred in S1); S2 preserves order; canary already picks one Champion.
- **Recommended default:** Allow S3 pure `SELECTED = first AVAILABLE`; still no Dispatcher/canary cutover.

### A-005 — Cutover timing vs API-only S3

- **Question:** Is S3 API+tests only, or must one product path call selection?
- **Evidence:** S1/S2 `ACTIVE_RUNTIME_CUTOVER: NO`; WP-004 still lists wiring as deferred.
- **Recommended default:** API+tests only; cutover = later slice after A-004.

### A-006 — Map unavailable outcomes → Control `FailureClass`

- **Question:** Should `NO_AVAILABLE_BINDING` / observation states become `AGENT_UNAVAILABLE`, `CREDENTIAL_UNAVAILABLE`, `CAPABILITY_BLOCK`, or stay Router-only until cutover?
- **Evidence:** DEC-004-002: S2 does not map to FailureClass; gateways today collapse probe fail into missing `command_execution` → `CAPABILITY_BLOCK`.
- **Recommended default:** Defer mapping to cutover; do not silently keep collapsing credential/agent into capability once Router is wired.

### A-007 — Persist `binding_id` on `dispatches` (or durable routing evidence)

- **Question:** Before failover, must claim/accept records include registry `binding_id`?
- **Evidence:** `dispatches` has no binding column; `adapter_id` ≠ `binding_id`.
- **Recommended default:** YES as prerequisite for failover; **not** required for API-only S3.

### A-008 — `adapter_id` vs `binding_id` identity model

- **Question:** Should Gateway `identity.adapter_id` become registry `binding_id`, or remain gateway-class id with binding recorded separately?
- **Evidence:** `gateway-builder` vs `cursor-cli`; Git reality context uses `adapter_id`.
- **Recommended default:** Keep gateway-class `adapter_id`; record `binding_id` separately when cutover lands.

---

## RESULT field summaries

| Field | Value |
| --- | --- |
| QUOTA_STATUS | ABSENT |
| COST_STATUS | ABSENT |
| DISPATCH_INTEGRATION_STATUS | Role→Champion hardcoded in canary/gateways; Dispatcher has no Router import; S1+S2 APIs unwired |
| ESCALATION_PREREQUISITES | Semantic PC exists; Router rebinding ABSENT; multi-binding ranking ABSENT; model-policy external |
| FAILOVER_PREREQUISITES | Attempt+fence+partial cancel/idempotency YES; durable `binding_id` NO; selection NO |
| SQLITE_REQUIRED_FOR_NEXT_SLICE | NO |
| RECOMMENDED_NEXT_SLICE | WP-004-S3 — Deterministic binding selection from S1∩S2 (API-only; no active cutover) |
| AMBIGUOUS_ITEMS | A-004;A-005;A-006;A-007;A-008 |
