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
