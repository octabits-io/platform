---
"@octabits-io/flow": minor
---

**flow/ai:** add embedding-model usage instrumentation. New exports `createInstrumentedEmbeddingModel` and `createEmbeddingUsageAccumulator` (with `EmbeddingUsageAccumulator` / `EmbeddingAccumulatedUsage` types) mirror the existing language-model instrumentation for `EmbeddingModelV4`: they transparently capture input-token usage from every `embed`/`embedMany` call via the AI SDK's `wrapEmbeddingModel` middleware, additively across a batch, with a `reset()` for long-lived accumulators. The recorded `inputTokens` feed straight into the existing `estimateCostMicros` pricing table (output/cache fields = 0). Provider-agnostic. Unblocks consumers that track embedding costs (e.g. listing-vector / semantic-search pipelines).
