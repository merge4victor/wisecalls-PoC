# Adopt Q in Connect AI agents and prompts into CloudFormation

Status: approved by operator (Ben Mergen), 2026-08-09. Ready for implementation
planning.

This is **Project 1 of 2**. Project 2 (a speech front door replacing the
eight-option DTMF menu on `wisecalls-voice-v1-dev`) is deliberately deferred
until this lands, so that adding a fifth AI agent is a purely additive template
edit rather than a change against a moving target.

## Problem

Four Amazon Q in Connect resources of type `AWS::Wisdom::AIAgent` and four of
type `AWS::Wisdom::AIPrompt` exist in `ap-southeast-2`, `ACTIVE` and
`PUBLISHED`, created 2026-07-31. They implement the four AI agent
configurations mandated by `docs/04-connect-configuration.md` §4.8.

None of them are in `infrastructure/template.yaml`. The template contains only
`KnowledgeAssistant` (`AWS::Wisdom::Assistant`), `KnowledgeBase` and
`KnowledgeAssociation`. The eight AI resources were created out-of-band.

Consequences:

- A stack rebuild would not reproduce them.
- `docs/08-operations-and-rollback.md` does not cover them, so the rollback
  evidence required by `CLAUDE.md` ("Completion evidence") is incomplete.
- Their configuration is not reviewable in version control, which matters
  because the prompt bodies encode the safety posture in
  `config/ai-agent-instructions.md`.

## Resources to adopt

All eight are bound to the existing `KnowledgeAssistant`. All four prompts use
model `au.anthropic.claude-sonnet-4-5-20250929-v1:0` (Claude Sonnet 4.5 on the
Australia cross-region inference profile).

| Name | Type | Detail |
|---|---|---|
| `wisecalls-dev-public-self-service` | `AIAgent` / `SELF_SERVICE` | KB association only |
| `wisecalls-dev-authenticated-self-service` | `AIAgent` / `SELF_SERVICE` | KB association only |
| `wisecalls-dev-agent-assistance` | `AIAgent` / `ANSWER_RECOMMENDATION` | KB association only |
| `wisecalls-dev-case-summarization` | `AIAgent` / `CASE_SUMMARIZATION` | locale `en_AU`, no KB association |
| `wisecalls-dev-self-service-preprocessing` | `AIPrompt` / `SELF_SERVICE_PRE_PROCESSING` | `MESSAGES`, 1198 chars |
| `wisecalls-dev-self-service-answer-generation` | `AIPrompt` / `SELF_SERVICE_ANSWER_GENERATION` | `TEXT_COMPLETIONS`, 1029 chars |
| `wisecalls-dev-agent-answer-generation` | `AIPrompt` / `ANSWER_GENERATION` | `TEXT_COMPLETIONS`, 738 chars |
| `wisecalls-dev-case-summarization` | `AIPrompt` / `CASE_SUMMARIZATION` | `MESSAGES`, 617 chars |

All four prompt bodies are small enough to embed literally in the template as
block scalars. Every `TemplateType` is `TEXT`.

## Decisions made during brainstorming

- **Import, not recreate.** Both resource types expose `create`, `read`,
  `update`, `delete` and `list` handlers with a composite `primaryIdentifier`
  of `[AIAgentId, AssistantId]` / `[AIPromptId, AssistantId]`. These are the
  preconditions for CloudFormation resource import, so the live `PUBLISHED`
  resources are never destroyed.
- **`--import-existing-resources` on a regular UPDATE change set**, not
  `--change-set-type IMPORT`. The classic import path additionally requires
  `DeletionPolicy: Retain` on every imported resource and forbids bundling any
  other change in the same change set. The newer flag requires neither and does
  not need an explicit `--resources-to-import` identifier list.
- **One-time out-of-band change set.** `aws cloudformation deploy` does not
  support `--import-existing-resources`; only `aws cloudformation create-change-set`
  does. `scripts/deploy.ps1:60` uses `deploy`, so the import cannot run through
  the normal deployment script. After the import executes, `deploy.ps1` resumes
  working unchanged and needs no modification.
- **No literal resource IDs in the repository.** Cross-references resolve
  through CloudFormation intrinsics: `AssistantId` is `!Ref KnowledgeAssistant`,
  the agents' knowledge-base `AssociationId` is `!Ref KnowledgeAssociation`
  (`template.yaml:1405`), and each agent's prompt IDs are `!Ref` to the adopted
  prompt resources. Account ID and resource UUIDs stay out of version control.
- **Scope limited to adoption.** The imported definitions must describe what is
  live today, not what it should become. Any configuration improvement is
  Project 2 work, because mixing it in would make gate 2 below unusable as a
  correctness signal.

## Design

### Template changes

Eight new resources in `infrastructure/template.yaml`, placed alongside the
existing Wisdom resources (after `KnowledgeAssociation`, before
`KnowledgeAssistantConnectAssociation`).

Two constraints govern how they must be written, both derived from the
resource schemas:

1. **`Name` and `Type` are `createOnly`** on both `AIAgent` and `AIPrompt`
   (also `ApiFormat` and `TemplateType` on `AIPrompt`; also `Tags` on both).
   Any mismatch against the live resource causes CloudFormation to plan a
   *replacement* rather than an import.
2. **The live resources have no tags** (`tags: {}`). The surrounding Wisdom
   resources in the template all carry `Project` and `Environment` tags, so the
   natural instinct is to add them here for consistency. Doing so would force a
   replacement, because `Tags` is `createOnly`. The adopted resources must be
   written with **no `Tags` property at all**. Tagging them is a follow-up that
   requires a separate delete-and-recreate decision, not part of this import.

All eight resources carry `Condition: CreateKnowledgeResources`, matching the
Wisdom resources they depend on.

Two further notes for the implementer:

- **`VisibilityStatus` is not a CloudFormation property** on either
  `AWS::Wisdom::AIAgent` or `AWS::Wisdom::AIPrompt`. The template therefore
  cannot express the live `PUBLISHED` state, and must not attempt to. Import
  preserves it; it simply is not part of the resource's CloudFormation
  contract.
- **The case-summarization agent and prompt share the AWS resource name**
  `wisecalls-dev-case-summarization`. This is legal in AWS because they are
  different resource types, but the two CloudFormation logical IDs must differ
  — e.g. `CaseSummarizationAIAgent` and `CaseSummarizationAIPrompt`.

Prompt bodies are copied verbatim from the live resources. The implementation
plan must include a byte-level comparison of each templated body against
`get-ai-prompt` output, since a whitespace difference would show as an update
rather than a clean import.

### Verification gates

Two gates. The second is the one that proves the drift is actually closed.

**Gate 1 — the import change set.** Must show **8 imports, 0 replacements,
0 deletions**. Because `Name` and `Type` are `createOnly`, any mismatch in the
identity-defining properties surfaces here as a replacement, before anything
executes. A change set that plans a replacement is not executed; the template
is corrected and the change set regenerated.

**Gate 2 — post-import no-op deploy.** After the import executes, a normal
`scripts/deploy.ps1 -Execute` must produce an **empty change set**. If it wants
to modify any of the eight resources, the templated definition does not match
reality and the drift has moved rather than closed. This gate is the acceptance
criterion for the project.

### Rollback

Cheaper than a typical stack change, because import never mutates the live
resources:

- Before execution: delete the change set. Nothing has changed.
- After execution with a bad definition: the resources are now stack-managed
  with a wrong template. Correct the template and run a normal update. The live
  agents keep serving throughout, since no flow invokes them yet.
- Worst case (resources accidentally replaced): the agent and prompt
  configurations are fully recorded in this spec and in the template itself, so
  they can be recreated. Their IDs would change, which matters only once
  Project 2 references them.

Record in `docs/08-operations-and-rollback.md` that the eight AI resources are
stack-managed from this change onward.

## Known gap recorded, not fixed here

`wisecalls-dev-public-self-service` and `wisecalls-dev-authenticated-self-service`
have **byte-identical configurations**: the same
`selfServicePreProcessingAIPromptId`, the same
`selfServiceAnswerGenerationAIPromptId`, the same single knowledge-base
association, and no tool associations at all. The only difference between them
is the `description` string, which the model never receives.

Therefore the trust-state separation described in `docs/01-architecture.md` §
"Trust states" and the authentication rules in `config/ai-agent-instructions.md`
are **not enforced by any configuration difference between these two agents**.
Whatever the public agent can do, the authenticated agent can do, and vice
versa.

This is currently harmless: neither agent has tools, and no contact flow
invokes either of them. It stops being harmless the moment Project 2 wires an
agent into `wisecalls-voice-v1-dev`.

It is deliberately out of scope here. Fixing it means changing live agent
configuration, which would break Gate 2 — the whole point of which is that the
template matches what already exists. Project 2 owns the fix, alongside the
tool associations (`get_product_rate`, `find_nearest_atms`,
`get_customer_context`, `get_recent_cases`) that the self-service agents were
specified to have in `docs/04-connect-configuration.md` §4.8 but do not.

## Out of scope for this project

- Any change to live AI agent or prompt configuration.
- Tool / MCP / Flow Module associations on the self-service agents.
- The public-vs-authenticated trust-state gap described above.
- Wiring any AI agent into a contact flow.
- Tagging the adopted resources.
- `AWS::Wisdom::AIAgentVersion` resources. No agent versions are pinned today;
  introducing them is a versioning-strategy decision, not part of adoption.
- Adopting the `amazon-connect-wise-calls-org` `MESSAGE_TEMPLATES` knowledge
  base, which Amazon Connect creates and manages automatically.

## Test plan

1. `node scripts/validate.mjs` passes (mandated by `CLAUDE.md` step 2).
2. `aws cloudformation validate-template` accepts the edited template.
3. Generate the import change set; confirm it lists exactly 8 resource imports,
   0 replacements and 0 deletions (Gate 1). Retain the change-set description
   as completion evidence.
4. Execute the change set; stack reaches `UPDATE_COMPLETE`.
5. `aws qconnect list-ai-agents` and `list-ai-prompts` return the same eight
   resource IDs as before the import, still `ACTIVE` and `PUBLISHED` —
   confirming import rather than replacement.
6. Run `scripts/deploy.ps1 -Execute` and confirm an empty change set (Gate 2).
7. Confirm `deploy.ps1` still succeeds unmodified, i.e. the one-time import
   path did not become a permanent requirement of normal deployments.
8. Regression: `wisecalls-voice-v1-dev` is untouched by this change. Confirm
   the flow definition is byte-identical to its pre-change state.
