# OpenMuse

OpenMuse keeps a user's conversations and durable agent work together.

## Language

**OpenMuse conversation**:
The conversation where a user makes a request and sees the resulting agent work.
_Avoid_: OpenBot thread

**AgentTask**:
A durable OpenMuse work item with a status and result that can continue beyond a conversation turn.
_Avoid_: OpenBot run, delegation record

**Delegated task**:
An AgentTask executed by a selected OpenBot Bot while remaining associated with its OpenMuse conversation.
_Avoid_: OpenBot run

**Outcome unknown**:
A nonterminal condition of a delegated task when OpenMuse cannot verify whether its linked OpenBot run stopped, failed, or finished.
_Avoid_: Failed, cancelled

**OpenBot thread**:
The OpenBot conversation context associated with a channel, separate from the originating OpenMuse conversation.
_Avoid_: OpenMuse conversation

**OpenBot run**:
One execution attempt by a selected Bot within an OpenBot thread.
_Avoid_: AgentTask
