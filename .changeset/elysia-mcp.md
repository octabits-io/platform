---
"@octabits-io/elysia": minor
---

Add `./mcp` subpath (`@octabits-io/elysia/mcp`): `createMcpRoutes`, the
per-request container harness both reynt MCP routes duplicate around
`elysia-mcp` in stateless mode. It owns the `pendingContainer` staging, the
`WeakMap<McpServer, scope>` handoff, per-request scope acquire, tenant-id
path parsing (`/^[a-zA-Z0-9-_]+$/`), and scope disposal on
`onAfterResponse`/`onError`. The auth differences (operator superadmin-grant
synthesis vs. the simpler customer flow) become the injected `resolveScope`
seam, and tool registration the `registerTools(server, getContainer)` seam.
Also exports `parseTenantId`, `jsonRpcError`, and `TENANT_ID_PATTERN`.
`elysia-mcp` and `@modelcontextprotocol/sdk` are OPTIONAL peers, so the root
export stays free of them.
