---
"@octabits-io/flow": minor
---

`./ai` gains store-agnostic quota enforcement and usage aggregation.

- `createAiQuotaService({ store, getQuota })` — concurrency / per-day / per-month workflow quota checks per `partitionKey`; quota config comes from an injected `getQuota` callback (`null` = exempt), errors surface as `ai_quota_exceeded` Result values.
- `createAiUsageAggregationService({ store })` — token/cost rollups (daily upsert deltas, date and workflow-type aggregation, current-quota-usage windows) reusing the existing `TokenUsage` shape.

Both engines talk to narrow structural stores (`AiQuotaStore`, `AiUsageStore`) so consumers keep raw SQL on their side; the ai layer stays free of pg/drizzle per the boundary lint.
