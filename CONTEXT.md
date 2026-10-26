# OpenMuse

OpenMuse is the phone surface for one person's Hermes agent. It keeps a user's
conversations and durable agent work together, and shows what the agent did.

## Language

**OpenMuse conversation**:
The conversation where a user makes a request and sees the resulting agent work.
_Avoid_: Hermes session, thread

**Hermes session**:
The upstream conversation context Hermes persists on the operator's machine. One
OpenMuse conversation maps to exactly one Hermes session; the mapping is stored
server-side and is opaque to the phone.
_Avoid_: OpenMuse conversation, thread id

**AgentTask**:
A durable OpenMuse work item with a status and result that can continue beyond a conversation turn.
_Avoid_: Hermes run, delegation record

**Hermes run**:
One execution attempt inside a Hermes session, owning tool calls, approvals, and its
terminal outcome.
_Avoid_: AgentTask

**Delegated task**:
An AgentTask executed by a worker agent Hermes dispatched, while remaining associated
with its OpenMuse conversation.
_Avoid_: Hermes run

**Outcome unknown**:
A nonterminal condition when OpenMuse cannot verify whether the linked Hermes work
stopped, failed, or finished.
_Avoid_: Failed, cancelled

**Bridge**:
The service that translates OpenMuse's AG-UI chat contract into Hermes's API-server
contract. It is the only integration seam.
_Avoid_: adapter, gateway, proxy

**Approval**:
A request from Hermes, raised mid-run, to execute an action that is external or
irreversible. It is not the same as an AgentTask review record.
_Avoid_: review, confirmation

## Retired vocabulary

OpenBot terms (OpenBot thread, OpenBot run, selected Bot) belong to the archived
pre-repurpose fork and are not used. CopilotKit Intelligence is no longer part of the
runtime; conversations persist as Hermes sessions.
