---
"@octabits-io/framework": minor
---

Add a `discarded` delivery status for mail a review gate rejected

`MAIL_DELIVERY_STATUSES` covered how a send *failed* but not the case where it
never happened: a confirmation gate holds a mail for review and a human decides
not to send it. Consumers had to reuse `failed`, which reads as a delivery error
that never occurred — misleading in an audit trail an operator reads.

`discarded` is appended to the tuple (no reordering, so any consumer deriving a
storage enum from it keeps its existing values). No provider emits it; it is set
by the gate that owns the hold.
