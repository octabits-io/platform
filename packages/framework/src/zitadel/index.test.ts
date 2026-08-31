import { describe, it, expect, vi, afterEach } from "vitest";
import { classifyZitadelError, createZitadelManagementClient } from "./index.ts";

describe("classifyZitadelError", () => {
  describe("already_exists", () => {
    it('matches the REST "already exists" wording', () => {
      expect(classifyZitadelError(new Error("resource already exists")).key).toBe("already_exists");
    });

    it('matches the squashed "alreadyexists" wording', () => {
      expect(classifyZitadelError(new Error("AlreadyExists: org")).key).toBe("already_exists");
    });

    it('matches the org-create "name or id already taken" wording', () => {
      // Real message returned by POST /v2/organizations on a name collision.
      const err = new Error(
        `{"code":6, "message":"Organisation's name or id already taken (V3-DKcYh)", "details":[{"@type":"type.googleapis.com/zitadel.v1.ErrorDetail","id":"V3-DKcYh","message":"Organisation's name or id already taken"}]}`,
      );
      expect(classifyZitadelError(err).key).toBe("already_exists");
    });

    it("matches the gRPC ALREADY_EXISTS status (code 6)", () => {
      expect(classifyZitadelError(new Error('{"code":6,"message":"conflict"}')).key).toBe(
        "already_exists",
      );
    });

    it("does not match an unrelated code containing a 6 (e.g. code 16)", () => {
      expect(classifyZitadelError(new Error('{"code":16,"message":"unauthenticated"}')).key).toBe(
        "api_error",
      );
    });
  });

  describe("not_found", () => {
    it('matches "not found"', () => {
      expect(classifyZitadelError(new Error("org not found")).key).toBe("not_found");
    });

    it("matches a 404 status", () => {
      expect(classifyZitadelError(new Error("request failed with status 404")).key).toBe(
        "not_found",
      );
    });

    it('matches the v2 "could not be found" wording', () => {
      // Real message from GET /v2/users/{id} on a miss (verified against a live
      // Zitadel in the integration suite). The bare "not found" match missed it.
      const err = new Error(
        '{"code":5,"message":"User could not be found (QUERY-Dfbg2)","details":[{"@type":"type.googleapis.com/zitadel.v1.ErrorDetail","id":"QUERY-Dfbg2","message":"User could not be found"}]}',
      );
      expect(classifyZitadelError(err).key).toBe("not_found");
    });

    it("matches the gRPC NOT_FOUND status (code 5)", () => {
      expect(classifyZitadelError(new Error('{"code":5,"message":"missing"}')).key).toBe(
        "not_found",
      );
    });

    it("does not match an unrelated code containing a 5 (e.g. code 15)", () => {
      expect(classifyZitadelError(new Error('{"code":15,"message":"data loss"}')).key).toBe(
        "api_error",
      );
    });
  });

  describe("api_error fallback", () => {
    it("falls back for unrecognised messages", () => {
      expect(classifyZitadelError(new Error("something exploded")).key).toBe("api_error");
    });

    it("falls back for non-Error values and stringifies the message", () => {
      const result = classifyZitadelError("plain string failure");
      expect(result.key).toBe("api_error");
      expect(result.message).toBe("plain string failure");
    });
  });

  it("preserves the original error as `cause` for Error inputs", () => {
    const err = new Error("already exists");
    expect(classifyZitadelError(err).cause).toBe(err);
  });
});

/**
 * Route-keyed fetch mock: each entry maps a URL substring to a JSON response.
 * Captures every request (url, method, headers, parsed body) for assertions.
 */
function mockFetch(routes: Array<{ match: string; body: unknown }>) {
  const requests: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`no mock route for ${url}`);
    return new Response(JSON.stringify(route.body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requests };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createZitadelManagementClient", () => {
  const config = { issuerUrl: "https://auth.example.com/", pat: "pat-123" };

  it("listOrgMembers maps raw grants to entries and sets the org header", async () => {
    const { requests } = mockFetch([
      {
        match: "/management/v1/users/grants/_search",
        body: {
          result: [
            {
              id: "g1",
              userId: "u1",
              roleKeys: ["admin", "member"],
              displayName: "Ada",
              email: "ada@example.com",
              details: { creationDate: "2026-01-02T03:04:05Z" },
            },
            // No id / roleKeys / profile fields — exercises the fallbacks.
            { userId: "u2" },
          ],
        },
      },
    ]);

    const client = createZitadelManagementClient(config);
    const result = await client.listOrgMembers("org-1", { roleKey: "admin" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      {
        grantId: "g1",
        userId: "u1",
        roles: ["admin", "member"],
        displayName: "Ada",
        email: "ada@example.com",
        createdAt: new Date("2026-01-02T03:04:05Z"),
      },
      {
        grantId: "u2",
        userId: "u2",
        roles: [],
        displayName: "",
        email: "",
        createdAt: new Date(0),
      },
    ]);
    expect(requests[0]?.headers.get("x-zitadel-orgid")).toBe("org-1");
    expect(requests[0]?.body).toEqual({ queries: [{ roleKeyQuery: { roleKey: "admin" } }] });
    // Trailing issuer-URL slash is stripped before path joining.
    expect(requests[0]?.url).toBe("https://auth.example.com/management/v1/users/grants/_search");
  });

  it("syncProjectGrant excludes platformOnlyRoles from a created grant", async () => {
    const { requests } = mockFetch([
      {
        match: "/roles/_search",
        body: { result: [{ key: "member" }, { key: "superadmin" }, { key: "admin" }] },
      },
      { match: "/grants/_search", body: { result: [] } },
      { match: "/grants", body: { grantId: "pg-1" } },
    ]);

    const client = createZitadelManagementClient({
      ...config,
      platformOnlyRoles: ["superadmin"],
    });
    const result = await client.syncProjectGrant({
      projectId: "p1",
      projectOwnerOrgId: "owner-org",
      grantedOrgId: "granted-org",
    });

    expect(result).toEqual({ ok: true, value: { grantId: "pg-1" } });
    const create = requests.find((r) => r.url.endsWith("/projects/p1/grants"));
    expect(create?.body).toEqual({
      grantedOrgId: "granted-org",
      roleKeys: ["admin", "member"], // sorted, superadmin excluded
    });
  });

  it("syncProjectGrant grants every project role when platformOnlyRoles is omitted", async () => {
    const { requests } = mockFetch([
      {
        match: "/roles/_search",
        body: { result: [{ key: "member" }, { key: "superadmin" }] },
      },
      { match: "/grants/_search", body: { result: [] } },
      { match: "/grants", body: { grantId: "pg-1" } },
    ]);

    const client = createZitadelManagementClient(config);
    await client.syncProjectGrant({
      projectId: "p1",
      projectOwnerOrgId: "owner-org",
      grantedOrgId: "granted-org",
    });

    const create = requests.find((r) => r.url.endsWith("/projects/p1/grants"));
    expect(create?.body).toEqual({
      grantedOrgId: "granted-org",
      roleKeys: ["member", "superadmin"],
    });
  });

  it("addProjectRole posts the role to the owning org and defaults displayName", async () => {
    const { requests } = mockFetch([{ match: "/projects/p1/roles", body: {} }]);

    const client = createZitadelManagementClient(config);
    const result = await client.addProjectRole({
      projectId: "p1",
      projectOwnerOrgId: "owner-org",
      roleKey: "viewer",
    });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(requests[0]?.url).toBe("https://auth.example.com/management/v1/projects/p1/roles");
    expect(requests[0]?.headers.get("x-zitadel-orgid")).toBe("owner-org");
    expect(requests[0]?.body).toEqual({ roleKey: "viewer", displayName: "viewer", group: "" });
  });

  it("addProjectRole classifies a duplicate key as already_exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("role already exists", { status: 409 })),
    );

    const client = createZitadelManagementClient(config);
    const result = await client.addProjectRole({
      projectId: "p1",
      projectOwnerOrgId: "owner-org",
      roleKey: "viewer",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.key).toBe("already_exists");
  });

  it("listProjectGrants reads grantedRoleKeys, the name the search response uses", async () => {
    const { requests } = mockFetch([
      {
        match: "/grants/_search",
        body: {
          result: [
            { grantId: "pg-1", grantedOrgId: "org-a", grantedRoleKeys: ["admin", "member"] },
            // Write-side spelling — accepted as a fallback.
            { grantId: "pg-2", grantedOrgId: "org-b", roleKeys: ["admin"] },
            // Neither field — a grant with no delegated roles.
            { grantId: "pg-3", grantedOrgId: "org-c" },
          ],
        },
      },
    ]);

    const client = createZitadelManagementClient(config);
    const result = await client.listProjectGrants({
      projectId: "p1",
      projectOwnerOrgId: "owner-org",
    });

    expect(result).toEqual({
      ok: true,
      value: [
        { grantId: "pg-1", grantedOrgId: "org-a", roleKeys: ["admin", "member"] },
        { grantId: "pg-2", grantedOrgId: "org-b", roleKeys: ["admin"] },
        { grantId: "pg-3", grantedOrgId: "org-c", roleKeys: [] },
      ],
    });
    expect(requests[0]?.headers.get("x-zitadel-orgid")).toBe("owner-org");
  });

  it("syncProjectGrant skips the PUT when grantedRoleKeys already match", async () => {
    const { requests } = mockFetch([
      { match: "/roles/_search", body: { result: [{ key: "member" }, { key: "admin" }] } },
      {
        match: "/grants/_search",
        body: {
          result: [
            { grantId: "pg-1", grantedOrgId: "granted-org", grantedRoleKeys: ["member", "admin"] },
          ],
        },
      },
    ]);

    const client = createZitadelManagementClient(config);
    const result = await client.syncProjectGrant({
      projectId: "p1",
      projectOwnerOrgId: "owner-org",
      grantedOrgId: "granted-org",
    });

    expect(result).toEqual({ ok: true, value: { grantId: "pg-1" } });
    // The whole point of the fix: an up-to-date grant is two reads and no write.
    expect(requests.filter((r) => r.method === "PUT")).toHaveLength(0);
  });

  it("syncProjectGrant PUTs the full role set when the grant is missing one", async () => {
    const { requests } = mockFetch([
      {
        match: "/roles/_search",
        body: { result: [{ key: "member" }, { key: "admin" }, { key: "viewer" }] },
      },
      {
        match: "/grants/_search",
        body: {
          result: [
            { grantId: "pg-1", grantedOrgId: "granted-org", grantedRoleKeys: ["admin", "member"] },
          ],
        },
      },
      { match: "/grants/pg-1", body: {} },
    ]);

    const client = createZitadelManagementClient(config);
    const result = await client.syncProjectGrant({
      projectId: "p1",
      projectOwnerOrgId: "owner-org",
      grantedOrgId: "granted-org",
    });

    expect(result).toEqual({ ok: true, value: { grantId: "pg-1" } });
    const put = requests.find((r) => r.method === "PUT");
    expect(put?.url).toBe("https://auth.example.com/management/v1/projects/p1/grants/pg-1");
    expect(put?.body).toEqual({ roleKeys: ["admin", "member", "viewer"] });
  });

  it("returns a classified Result.error instead of throwing on request failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("org not found", { status: 404 })),
    );

    const client = createZitadelManagementClient(config);
    const result = await client.listOrganizations();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.key).toBe("not_found");
  });
});

/**
 * Fetch mock for the instance-wide grant index. One handler sees every request
 * (url, org header, parsed body) and answers with a payload — or returns a
 * `Response` of its own for the failure paths.
 */
function mockRoutedFetch(handler: (req: RoutedRequest) => unknown) {
  const requests: RoutedRequest[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: RoutedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      orgId: new Headers(init?.headers).get("x-zitadel-orgid"),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    };
    requests.push(req);
    const answer = handler(req);
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requests };
}

interface RoutedRequest {
  url: string;
  method: string;
  orgId: string | null;
  body?: Record<string, unknown>;
}

const CONFIG = { issuerUrl: "https://auth.example.com/", pat: "pat-123" };

/**
 * The user lifecycle calls. Each is a one-line request, so what is worth
 * pinning is the pair (verb, path) — a deactivate that reached the delete
 * endpoint is an unrecoverable mistake that no type catches — plus the
 * classification of the two states a caller must be able to tell apart:
 * "already gone" and "refused".
 */
describe("createZitadelManagementClient — user lifecycle", () => {
  it("deactivateUser POSTs the v2 deactivate endpoint", async () => {
    const { requests } = mockRoutedFetch(() => ({}));

    const client = createZitadelManagementClient(CONFIG);
    const result = await client.deactivateUser("u1");

    expect(result).toEqual({ ok: true, value: undefined });
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toBe("https://auth.example.com/v2/users/u1/deactivate");
  });

  it("reactivateUser POSTs the v2 reactivate endpoint", async () => {
    const { requests } = mockRoutedFetch(() => ({}));

    const client = createZitadelManagementClient(CONFIG);
    const result = await client.reactivateUser("u1");

    expect(result).toEqual({ ok: true, value: undefined });
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toBe("https://auth.example.com/v2/users/u1/reactivate");
  });

  it("deleteUser DELETEs the user resource itself", async () => {
    const { requests } = mockRoutedFetch(() => ({}));

    const client = createZitadelManagementClient(CONFIG);
    const result = await client.deleteUser("u1");

    expect(result).toEqual({ ok: true, value: undefined });
    expect(requests[0]?.method).toBe("DELETE");
    expect(requests[0]?.url).toBe("https://auth.example.com/v2/users/u1");
  });

  it("deleteUser reports an already-deleted user as not_found", async () => {
    // The documented contract: a caller sweeping stale accounts can report
    // "already gone" instead of a failure.
    mockRoutedFetch(
      () =>
        new Response('{"code":5,"message":"User could not be found (QUERY-Dfbg2)"}', {
          status: 404,
        }),
    );

    const client = createZitadelManagementClient(CONFIG);
    const result = await client.deleteUser("u1");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.key).toBe("not_found");
  });

  it("deactivateUser surfaces an already-deactivated user as an error, not success", async () => {
    // Zitadel answers FAILED_PRECONDITION (code 9). The module deliberately
    // does not swallow it — a caller that treats "already locked" as success
    // has to check state first, so this must not quietly return ok.
    mockRoutedFetch(
      () =>
        new Response('{"code":9,"message":"User is already deactivated (COMMAND-5M0sd)"}', {
          status: 400,
        }),
    );

    const client = createZitadelManagementClient(CONFIG);
    const result = await client.deactivateUser("u1");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.key).toBe("api_error");
  });
});

/**
 * `type` on a searched user. A machine account is how an integration
 * authenticates — it holds no project grant by design — so a stale-account
 * sweep that cannot tell it from an abandoned human deletes the credentials
 * the sweep itself runs on.
 */
describe("createZitadelManagementClient — user type", () => {
  it("discriminates human, machine and neither on the user search", async () => {
    mockRoutedFetch(() => ({
      result: [
        { userId: "u1", human: { profile: { givenName: "Ada" } } },
        { userId: "u2", machine: { name: "ci-bot" } },
        { userId: "u3" },
      ],
      details: { totalResult: "3" },
    }));

    const client = createZitadelManagementClient(CONFIG);
    const result = await client.listAllUsers();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.map((u) => u.type)).toEqual(["human", "machine", "unknown"]);
  });
});

/**
 * The instance-wide grant index. Three properties carry the whole feature: it
 * asks every org (in that org's header context), it pages rather than
 * stopping at Zitadel's cap, and a failed org is *reported* rather than read
 * as "this user belongs to nobody" — the one confusion that turns a cleanup
 * sweep into a mass deletion.
 */
describe("createZitadelManagementClient — listAllUserGrants", () => {
  const ORGS = {
    result: [
      { id: "org-a", name: "Org A", primaryDomain: "a.example.com" },
      { id: "org-b", name: "Org B", primaryDomain: "b.example.com" },
    ],
  };

  it("searches each org in its own header context and falls back to the org record", async () => {
    const { requests } = mockRoutedFetch((req) => {
      if (req.url.includes("/v2/organizations/_search")) return ORGS;
      if (req.orgId === "org-a") {
        return {
          result: [
            {
              id: "g1",
              userId: "u1",
              orgId: "org-a",
              orgName: "Org A (renamed)",
              orgDomain: "renamed.example.com",
              projectId: "p1",
              roleKeys: ["admin"],
              details: { creationDate: "2026-01-02T03:04:05Z" },
            },
          ],
        };
      }
      // No orgName/orgDomain/roleKeys — exercises the fallbacks.
      return { result: [{ id: "g2", userId: "u2", orgId: "org-b", projectId: "p1" }] };
    });

    const client = createZitadelManagementClient(CONFIG);
    const result = await client.listAllUserGrants();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.failedOrgIds).toEqual([]);
    expect(result.value.grants).toEqual([
      {
        grantId: "g1",
        userId: "u1",
        orgId: "org-a",
        orgName: "Org A (renamed)",
        orgPrimaryDomain: "renamed.example.com",
        projectId: "p1",
        roles: ["admin"],
        createdAt: new Date("2026-01-02T03:04:05Z"),
      },
      {
        grantId: "g2",
        userId: "u2",
        orgId: "org-b",
        orgName: "Org B",
        orgPrimaryDomain: "b.example.com",
        projectId: "p1",
        roles: [],
        createdAt: new Date(0),
      },
    ]);
    // One search per org, each carrying that org's id.
    const searches = requests.filter((r) => r.url.includes("/users/grants/_search"));
    expect(searches.map((r) => r.orgId)).toEqual(["org-a", "org-b"]);
  });

  it("pages a full org and stops on the first short page", async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      id: `g${i}`,
      userId: `u${i}`,
      orgId: "org-a",
      projectId: "p1",
    }));
    const { requests } = mockRoutedFetch((req) => {
      if (req.url.includes("/v2/organizations/_search")) {
        return { result: [ORGS.result[0]] };
      }
      const query = req.body?.query as { offset?: string } | undefined;
      if (query?.offset === "0") return { result: fullPage };
      return { result: [{ id: "tail", userId: "u-tail", orgId: "org-a", projectId: "p1" }] };
    });

    const client = createZitadelManagementClient(CONFIG);
    const result = await client.listAllUserGrants();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.grants).toHaveLength(1001);
    const searches = requests.filter((r) => r.url.includes("/users/grants/_search"));
    // Exactly two: a full page asks for the next, a short page ends the walk.
    expect(searches).toHaveLength(2);
    expect(searches.map((r) => (r.body?.query as { offset: string }).offset)).toEqual(["0", "1000"]);
  });

  it("records an org it could not ask in failedOrgIds and keeps the other orgs' grants", async () => {
    const warn = vi.fn();
    mockRoutedFetch((req) => {
      if (req.url.includes("/v2/organizations/_search")) return ORGS;
      if (req.orgId === "org-a") return new Response("boom", { status: 500 });
      return { result: [{ id: "g2", userId: "u2", orgId: "org-b", projectId: "p1" }] };
    });

    const client = createZitadelManagementClient({ ...CONFIG, logger: { warn } });
    const result = await client.listAllUserGrants();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Partial, and it says so — the caller decides whether that is usable.
    expect(result.value.grants.map((g) => g.userId)).toEqual(["u2"]);
    expect(result.value.failedOrgIds).toEqual(["org-a"]);
    expect(warn).toHaveBeenCalledWith(
      "failed to list user grants for org",
      expect.objectContaining({ orgId: "org-a" }),
    );
  });

  it("propagates a failure to list the organizations rather than answering empty", async () => {
    // No orgs read means no grants read — answering `{ grants: [], failedOrgIds: [] }`
    // here would state that nobody on the instance holds a grant.
    mockRoutedFetch(() => new Response("org not found", { status: 404 }));

    const client = createZitadelManagementClient(CONFIG);
    const result = await client.listAllUserGrants();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.key).toBe("not_found");
  });
});
