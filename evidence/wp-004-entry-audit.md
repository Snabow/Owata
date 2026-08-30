# WP-004 Entry Audit 窶・Phase 4 Router

**AUDIT_ID:** OWATA-REQ-0069
**AUDIT_BASE:** `6f26864bd15fc6cb737a99e85a978d95defd5de1`
**WP003_DONE:** YES
**PHASE4_STATUS:** NOT_STARTED
**IMPLEMENTATION_CHANGED:** NO

**Branch:** `wp-004/router-entry-audit`
**Authority:** Program Control (Charter Phase 4)
**Scope:** Audit only 窶・no Router implementation in this request.

---

## Executive conclusion

WP-003 closed Human Clipboard Zero and durable handoff. Phase 4 (Router) is the next Charter stage, but the repo already has **role adapters**, **Champion bindings**, **capability preflight**, and **probe/auth availability** for a *single configured binding*.

What is **missing** for Phase 4 is a **provider-neutral registry + capability profile + deterministic eligibility filter**. Without that foundation, quota/cost/escalation/failover would either hardcode Champions or duplicate Control Core semantics.

**Recommended first implementation slice (exactly one):**
`WP-004-S1 窶・Provider Registry + Capability Profile + deterministic eligibility filter`

Do **not** implement live failover, quota APIs, cost pricing, or semantic Program Control in S1.

---

## Phase 4 requirement matrix

| ID | Requirement | Classification | Existing evidence | Missing | First-slice? | Smallest action |
| --- | --- | --- | --- | --- | --- | --- |
| P4-01 | Provider registry | TRUE_PHASE4_GAP | Hardcoded Champion bindings only (`cursor-cli`, `codex-cli`); Charter ﾂｧ7 provisional Champions | Durable/provider-neutral registry of runtimes/bindings | **YES** | Define registry records + load/list API |
| P4-02 | Capability profile | TRUE_PHASE4_GAP | Role `Capability` / adapter `capabilities()` / `required_capabilities` preflight (`src/control/protocol.ts`, `adapters.ts`, gateways) | Provider/runtime profiles (not role work-permissions) | **YES** | Attach static capability profile per registry entry |
| P4-03 | Availability | TRUE_PHASE4_GAP (substrate for one binding) | `probe()` / `authReady` / `AGENT_UNAVAILABLE` / `CREDENTIAL_UNAVAILABLE` | Cross-provider availability map / multi-binding observation | No (S1 may reuse probe bits only) | Reuse probe as input to eligibility; defer multi-provider map |
| P4-04 | Quota | TRUE_PHASE4_GAP | Canary budget only (`src/canary/b2-full-invocation-budget.ts`) 窶・non-product | Durable quota representation before live APIs | No | Deferred: config/observed budget object later |
| P4-05 | Cost | TRUE_PHASE4_GAP | Charter Axis A / Phase 4 bullet only | Measured vs configured vs unknown cost model | No | Deferred: unknown-by-default cost fields |
| P4-06 | Automatic escalation | DEFERRED_WITHIN_PHASE4 | Charter ﾂｧ5.7; DEC-003-002 future escalate | Policy for stronger model/provider under constraints | No | After registry+eligibility |
| P4-07 | Failover | DEFERRED_WITHIN_PHASE4 | Fail-closed no-fake-fallback (PC/Reviewer gateways) | Alternate eligible binding selection under fencing | No | After registry+availability |
| P4-08 | Role capability preflight | SUBSTRATE_EXISTS | Dispatcher preflight + `CAPABILITY_BLOCK` | None for Phase 4 product | No | Reuse; do not rebuild as 窶廚apability Profile窶・|
| P4-09 | Champion/Challenger R&D process | NON_GOAL (first slice) | Charter ﾂｧ7 process | 窶・| No | Not a Router module |

---

## Existing reusable substrate

| Substrate | Paths | Reuse note |
| --- | --- | --- |
| Role adapters | `src/control/adapters.ts` | Logical PC/Builder/Reviewer boundaries stay |
| Binding interfaces | `src/execution/binding.ts`, `src/reviewer/binding.ts`, `src/program-control/binding.ts` | Champions remain replaceable behind interfaces |
| Gateways | `src/execution/gateway.ts`, `src/reviewer/gateway.ts`, `src/program-control/gateway.ts` | Fail-closed invocation; not semantic PC |
| Capability enum + missingCapabilities | `src/control/protocol.ts` | Request-required capabilities remain Control Core |
| Preflight / CAPABILITY_BLOCK | `src/control/dispatcher.ts`, `handoff.ts` | Keep as authority path when no eligible binding |
| Probe availability | Binding `probe()` 竊・gateway preflight | Feed eligibility; not multi-provider yet |
| Failure classes | `AGENT_UNAVAILABLE`, `CREDENTIAL_UNAVAILABLE`, `CAPABILITY_BLOCK` | Map NO_ELIGIBLE / auth / agent failures |
| Model-policy (canary/Builder) | `src/execution/model-policy.ts` | **Local experiment/canary policy** 窶・must not become universal architecture |
| Hardcoded Champions | `cursor-cli.ts`, `codex-cli.ts` (PC+Reviewer), canaries | Become registry *entries*, not architecture |

---

## True Phase 4 gaps

1. **No Model Router / provider registry module** (`src/**/*rout*` absent).
2. **No durable provider/runtime capability profiles** distinct from role work-capabilities.
3. **No deterministic eligibility API** returning ELIGIBLE set / NO_ELIGIBLE_BINDING for a role+request.
4. **No product quota / cost / multi-provider availability / escalation / failover** (charter bullets remain open after S1).

---

## Authority boundary

| Actor | Decides |
| --- | --- |
| **Program Control** | Meaningful next action, REWORK scope, ACCEPT, Human Gate, redesign |
| **Router (future)** | Eligible runtime/provider/model under durable policy + constraints only |
| **Dispatcher / Control Core** | Fencing, request identity, claim/lease, CAPABILITY_BLOCK recovery |
| **Human** | Goals, constraints, approval, credential recovery 窶・**not** routine provider/model Clipboard |

Router MUST NOT become semantic Program Control.
Do not encode architecture as ChatGPT/Cursor/Codex/Claude-specific routing.
Current Champions are bindings, not logical roles.

---

## Durable-state implications

| Kind | Durable? | Notes |
| --- | --- | --- |
| Provider/runtime registry config | Yes | Authoritative configuration (repo and/or SQLite) |
| Capability profiles | Yes | Versioned with registry |
| Eligibility decisions (audit) | Prefer durable event/log | Reconstructable 窶忤hy this binding窶・|
| Probe observations | Ephemeral cache OK | May refresh; do not treat session as authority |
| Quota/cost observations | Deferred; when added 竊・durable | Never scrape plan limits into source |
| Semantic PC decisions | Already durable | Router must not overwrite |

---

## Deferred Phase 4 work (after S1)

- Live provider API quota polling
- Cost accounting / volatile prices
- Automatic escalation policies
- Live multi-provider failover under fencing
- Generalized scheduling / subscription optimization

---

## Explicit non-goals (this audit / first slice)

- UI/dashboard, TFO, backup/restore, fault injection
- Credentials platform, Browser Relay cleanup, NB-001 hygiene
- New Agent/provider evaluation / Champion窶鼎hallenger experiments as product Router
- Universal 窶從ever use Claude窶・(canary model-policy 竕 architecture)
- Changing current model-policy in this audit

---

## Recommended first implementation slice (exactly one)

**Name:** `WP-004-S1 窶・Provider Registry + Capability Profile + deterministic eligibility filter`

**Success criterion:**
Given a logical role + control request (`required_capabilities` and related durable inputs), OWATA deterministically returns:

- an **ELIGIBLE** ordered set of registry bindings, or
- **NO_ELIGIBLE_BINDING**

**without:**

- choosing semantic next action (Program Control authority)
- live failover
- live quota API integration
- volatile price hardcoding
- Human provider/model selection for that dispatch

Empty eligibility maps to existing fail-closed outcomes (`CAPABILITY_BLOCK` / `AGENT_UNAVAILABLE` / `CREDENTIAL_UNAVAILABLE` as appropriate)窶馬ot silent fake fallback.

---

## Acceptance criteria (S1)

1. Durable provider/runtime registry abstraction (provider-neutral IDs).
2. Static capability profile per registry entry.
3. Deterministic eligibility filter over role + request capabilities (+ optional probe bits).
4. Unit tests: eligible / ineligible / empty set; no Champion name required in Core API.
5. Existing single-Champion wiring can be expressed as registry entries without changing PC semantics.
6. No live quota/cost/failover/escalation in S1.
7. Independent Review + Program Control acceptance before merge.

---

## Expected source touch points (future S1 窶・not this audit)

- New: e.g. `src/router/` or `src/provider-registry/` (name TBD by WP-004)
- Thin adapters from gateways/dispatcher to eligibility API
- Tests under matching `*.test.ts`
- Evidence / WP-004 canonical doc (created by Program Control after adjudication)

**This audit writes only:** `evidence/wp-004-entry-audit.md`

---

## Answers to required questions (summary)

| Question | Answer |
| --- | --- |
| Provider registry missing? | Durable list of provider-neutral runtime/binding records with profiles; replace hardcoded Champion construction as architecture |
| Capability profile vs existing? | Keep role `required_capabilities` preflight; add **provider/runtime** profiles for eligibility |
| Availability? | Reuse probe/auth; need both static declaration and runtime observation eventually; S1 may use probe as soft input only |
| Quota minimum? | Deferred: durable observed/configured budget object 窶・no scraping plan limits |
| Cost minimum? | Deferred: measured / configured estimate / unknown 窶・never bake volatile prices into Core |
| Automatic escalation? | Router policy may pick stronger eligible binding under durable rules; semantic REWORK/ACCEPT stays PC |
| Failover? | Only among eligible bindings; preserve fencing, request/candidate identity, Reviewer isolation, session non-authority, PC authority |
| Current bindings? | Cursor/Codex hardcoded in bindings + canaries 窶・abstract behind registry in S1; leave canary model remaps as experiment policy |
| Model policy vs Router? | Local Builder/canary non-Claude policy 竕 universal prohibition; Router must remain provider-agnostic |
| Durable vs ephemeral? | Registry/profiles/policy durable; probe cache ephemeral |
| Failure is state? | Unavailable / no-eligible / auth 竊・recoverable Control Core classes, not orphaned work |
| Human cognitive cost? | Human should not choose provider/model/binding per routine dispatch |

---

## Risks / ambiguous items requiring Program Control

| ID | Item | Why PC |
| --- | --- | --- |
| A-001 | Whether S1 must *select* a single binding vs return a set for Dispatcher/Gateway to consume | Wiring authority |
| A-002 | Whether canary non-Claude policy becomes a registry *tag* or stays outside product Router | Avoid universal ban |
| A-003 | Persistence medium for registry (repo config vs SQLite vs both) | Durability design |

---

## Counts

| Classification | Count (matrix rows P4-01窶ｦP4-09) |
| --- | --- |
| TRUE_PHASE4_GAP | 5 (registry, profile, availability-as-product, quota, cost) |
| DEFERRED_WITHIN_PHASE4 | 2 (escalation, failover) |
| SUBSTRATE_EXISTS | 1 (role preflight) |
| NON_GOAL | 1 (Champion process as first product) |
