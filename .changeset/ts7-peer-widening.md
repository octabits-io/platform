---
"@octabits-io/foundation": patch
"@octabits-io/flow": patch
"@octabits-io/elysia": patch
"@octabits-io/mail": patch
"@octabits-io/queue": patch
"@octabits-io/storage": patch
---

Widen the `typescript` peer range to `^5 || ^6 || ^7` — the packages build and typecheck cleanly under TypeScript 7 (native compiler), and the emitted declarations are semantically identical to the TS 5/6 output.
