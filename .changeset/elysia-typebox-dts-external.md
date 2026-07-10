---
"@octabits-io/elysia": patch
---

Fix consumer declaration-emit breakage introduced by the 0.7.1 tsdown/TS7 rebuild: declare `@sinclair/typebox` as a direct dependency (same `>= 0.34.0 < 1` range elysia itself uses) so the dts bundler keeps its types **external** (`import("@sinclair/typebox").…`) instead of inlining them as non-exported interfaces.

The 0.7.1 bundle inlined `SchemaOptions`, `TImport`, `TSchema`, … reachable through elysia's `t`/`Elysia` types without exporting them, so any consumer compiling with `declaration: true` failed with TS4023 ("uses name 'SchemaOptions' … but cannot be named") and TS4094 on every exported route creator — reynt's public-api typecheck broke against 0.7.1. With typebox declared, the emitted d.ts references it by module specifier, which consumers can resolve and name.
