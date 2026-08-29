# DEC-003-002 — Single Execution Gateway Pattern

**ID:** DEC-003-002
**Status:** ACCEPTED
**Date:** 2026-08-29
**Work Package:** WP-003
**Baseline:** Slice 1 R0 candidate `992a4d286586bc1eab0776fcc96e2ea79c0f1346`
**Authority:** Program Control (OWATA-REQ-0024)
**Related:** `decisions/DEC-003-001-wp003-architecture.md`

Convention: architecture decisions live in `decisions/DEC-<wp>-<seq>-<slug>.md`. Status is `PROPOSED` | `ACCEPTED` | `SUPERSEDED`. Chat history is not a Decision.

---

## Context

WP-003 Slice 1 proves durable structured handoff with fake adapters. Real adapter / runtime binding comes later. Program Control has approved a single Execution Gateway pattern so that later binding work does not invent product-specific authority in Control Core or depend on chat history.

This Decision is design direction only. It is **not** implemented in Slice 1 R1.

---

## Decision

Adopt a **Single Execution Gateway Pattern** for machine-facing execution intake after Program Control has chosen the next semantic action.

### Logical topology

Program Control remains the semantic authority for the next action.

A single Execution Gateway may serve as the normal machine-facing intake for execution requests.

```text
Program Control
→ Structured Control Request
→ Execution Gateway
├─ Builder runtime/model A
├─ Builder runtime/model B
├─ Architecture Challenger runtime
└─ Independent Reviewer transport
→ Structured Result
→ Program Control
```

### Gateway authority

The Gateway MAY choose execution binding within constraints supplied by Program Control, such as:

- role
- task class
- required capabilities
- complexity
- cost class / budget
- independence_required
- runtime availability

The Gateway MAY:

- choose a suitable Builder runtime/model
- use cheap/default execution for routine work
- escalate difficult Builder work to a stronger runtime/model
- invoke an explicitly allowed architecture Challenger
- transport an Independent Review request to a separately isolated Reviewer runtime

The Gateway MUST NOT:

- decide the project’s next semantic action
- convert Reviewer findings directly into REWORK instructions
- self-approve Builder output
- collapse Builder and Independent Reviewer trust domains
- silently change Work Package scope
- override Program Control decisions
- treat model/provider selection as project authority

### Trust-domain rule

Multiple Cursor-internal models/subagents used for implementation belong to the same **Builder trust domain** unless actual technical isolation and independent-review requirements establish otherwise.

Therefore Cursor Auto, Cursor subagents, and Claude/Fable/Opus invoked as Builder helpers do **not** become Independent Review merely because they use another model.

Independent Reviewer must retain:

- exact candidate identity
- isolated review environment
- no Builder conversational persuasion/context
- no Builder write authority
- immutable findings
- Program Control adjudication

### Initial Champion hypothesis

The initial Execution Gateway Champion may be Cursor because it can potentially provide repository/environment ownership, Builder execution, subagent/model selection, transport to an external Codex Reviewer, and later headless operation.

This is a Champion hypothesis, **not** a Control Core dependency. Control Core must continue to expose provider-neutral contracts.

### Routing direction

Future requests should be able to express semantic execution requirements instead of product names, conceptually:

- role
- task_class
- complexity
- required_capabilities
- cost_class
- independence_required

Example binding policy may later resemble:

| Intent | Binding (replaceable) |
| --- | --- |
| routine Builder | inexpensive/default Cursor execution |
| hard Builder | stronger Builder model/runtime |
| architecture challenge | high-reasoning Challenger such as Fable |
| independent review | isolated Codex or future Reviewer |

These bindings are replaceable and must not be encoded into Dispatcher semantics.

### Scope timing

Do **not** implement this Execution Gateway in Slice 1 R1.

It is a required design input for the real Adapter / runtime phase after Slice 1 is independently accepted.

Do not encode Cursor, Fable, Codex, ACP, or other providers into current Dispatcher logic.

---

## Consequences

- Slice 1 remains fake-adapter only; provider-neutral Control Core contracts stay authoritative.
- Later real-adapter work must treat Gateway binding as replaceable execution policy under Program Control constraints.
- Independent Review remains a separate trust domain from Builder helpers.
- WP-003 overall remains NOT DONE until real adapters and Human Clipboard Zero are proven.
