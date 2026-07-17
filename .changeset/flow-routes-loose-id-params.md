---
'@octabits-io/framework': patch
---

`createFlowWorkflowRoutes`: the `/:id` routes' params schema is now loose (`z.looseObject`). The previous strict schema stripped parent path params (e.g. a mounting app's `/tenant/:tenantId`) during validation — before the consumer's request-scope plugin could read them — breaking get/status/cancel/resume for any consumer mounted under a parameterized prefix.
