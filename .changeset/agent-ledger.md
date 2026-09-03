---
"@octabits-io/framework": minor
---

Agents as principals, on the ledger.

`./proposal`: `Principal` (`{ kind, id, label?, onBehalfOf?, authorizationId? }`)
on `provenance` and on `applied` — who acted, for whom, under which grant; a
`reversibility` class per operation (`reversible` | `compensable` |
`irreversible`), honoured by `invertOperations` (irreversible operations are
named, not undone) and summarised by `reversibilityOf`. Still zod-only.

`./drizzle/agent-ledger` (new): the append-only record of what agents did,
under whose grant, and how to undo it. `agentLedgerColumns` + 
`createDrizzleAgentLedgerStore` (record / get / findByWorkflow(s) /
listByActor / markReverted) + an in-memory twin. Deliberately the audit and
undo log, not event sourcing. Record types are structural duplicates of the
proposal contract's, so the contract stays a leaf.
