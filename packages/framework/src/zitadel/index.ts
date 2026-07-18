/**
 * @octabits-io/framework/zitadel — typed client for the Zitadel
 * **Management API** (not OIDC): search users, orgs, and project grants;
 * create/delete orgs; invite users; sync project grants; update user
 * profiles. `wretch` is the module's optional peer (shared with
 * `./mail/brevo`).
 *
 * Authenticates with a service-account Personal Access Token (PAT). Every
 * public method returns `Promise<Result<T, ZitadelApiError>>` — callers must
 * not rely on thrown errors to discriminate between recoverable states.
 *
 * The intended topology is Zitadel's multi-org SaaS shape: one **platform
 * org** owns a shared project (and hosts every user); each customer org
 * receives a *project grant* delegating that project, and users get *user
 * grants* referencing it. Single-org deployments simply omit
 * `projectOwnerOrgId` where it is optional.
 */
import wretch from "wretch";
import type { Result } from "../result/index.ts";

/** A user returned by Zitadel's user search. */
export interface ZitadelUser {
  userId: string;
  email: string;
  name: string;
  displayName: string;
  givenName: string | null;
  familyName: string | null;
  avatarUrl: string | null;
  preferredLanguage: string | null;
  state: string;
  createdAt: Date;
}

/** A project grant held by a user (org membership with roles). */
export interface ZitadelUserGrant {
  grantId: string;
  userId: string;
  orgId: string;
  orgName: string;
  orgPrimaryDomain: string;
  projectId: string;
  roles: string[];
  createdAt: Date;
}

/**
 * One entry from an org-scoped user-grant search ({@link listOrgMembers} /
 * {@link listMembersByProjectGrant}) — the raw wire shape lightly normalized.
 * `displayName`/`email` are populated when Zitadel includes them on the search
 * payload (best-effort); fall back to `getUserById` when presence must be
 * guaranteed.
 */
export interface ZitadelUserGrantEntry {
  grantId: string;
  userId: string;
  roles: string[];
  displayName: string;
  email: string;
  createdAt: Date;
}

/**
 * Discriminated error returned by every public method on the Zitadel client.
 *
 * - `not_found` — resource doesn't exist (HTTP 404 or "Member not found" lookup misses).
 * - `already_exists` — Zitadel rejected a create because the resource already exists.
 * - `missing_field` — Zitadel returned 2xx but omitted a field we depend on.
 * - `api_error` — every other failure (network, 4xx, 5xx, parse).
 */
export type ZitadelApiErrorKey = "not_found" | "already_exists" | "missing_field" | "api_error";

export interface ZitadelApiError {
  key: ZitadelApiErrorKey;
  message: string;
  cause?: unknown;
}

/**
 * Minimal structural logger seam — compatible with
 * `@octabits-io/framework/logger`'s `Logger` (a superset). Optional; a noop is
 * used when omitted.
 */
export interface ZitadelLogger {
  warn(message: string, attributes?: Record<string, unknown>): void;
}

/** Configuration for the Zitadel Management Client. */
export interface ZitadelManagementClientConfig {
  /** Zitadel issuer URL (e.g. `https://auth.example.com`). */
  issuerUrl: string;
  /** Personal Access Token for the service account. */
  pat: string;
  /** Optional structured logger; a noop is used when omitted. */
  logger?: ZitadelLogger;
  /**
   * Role keys defined on the project that belong to the project-owning org
   * only and must never be delegated to granted orgs via project grants
   * (e.g. a platform-only `superadmin` role). `syncProjectGrant` excludes
   * them from every grant's `roleKeys`. Defaults to none.
   */
  platformOnlyRoles?: readonly string[];
}

/**
 * Classify a thrown error from the wretch client into a typed ZitadelApiError.
 * Falls back to `api_error` for anything we don't recognise.
 *
 * Exported for unit testing — the wording-detection here is load-bearing for
 * conflict-recovery flows (a missed `already_exists` classification silently
 * disables reclaiming an orphaned org, for example).
 */
export function classifyZitadelError(err: unknown): ZitadelApiError {
  if (err instanceof Error) {
    const message = err.message;
    if (/404|not.?found/i.test(message)) {
      return { key: "not_found", message, cause: err };
    }
    // Zitadel surfaces uniqueness conflicts with varying wording — REST uses
    // "already exists", the org create endpoint says "name or id already taken",
    // and the underlying gRPC status is ALREADY_EXISTS (code 6).
    if (/already.?exists|alreadyexists|already.?taken|"code"\s*:\s*6\b/i.test(message)) {
      return { key: "already_exists", message, cause: err };
    }
    return { key: "api_error", message, cause: err };
  }
  return { key: "api_error", message: String(err) };
}

/**
 * Wrap an async block in a try/catch that converts any thrown error into a
 * `Result.error(ZitadelApiError)`. Used as the body of every public client method.
 */
async function tryRequest<T>(
  fn: () => Promise<Result<T, ZitadelApiError>>,
): Promise<Result<T, ZitadelApiError>> {
  try {
    return await fn();
  } catch (err) {
    return { ok: false, error: classifyZitadelError(err) };
  }
}

const noopLogger: ZitadelLogger = { warn: () => {} };

/**
 * Create a client for the Zitadel Management REST API.
 */
export function createZitadelManagementClient({
  issuerUrl,
  pat,
  logger = noopLogger,
  platformOnlyRoles = [],
}: ZitadelManagementClientConfig) {
  const baseUrl = issuerUrl.replace(/\/$/, "");

  // Base instance: auth + JSON content type + 204 handling
  const api = wretch(baseUrl)
    .auth(`Bearer ${pat}`)
    .content("application/json")
    .resolve((chain) =>
      chain.res(async (response) => {
        if (response.status === 204) return {};
        return response.json();
      }),
    );

  function withOrg(orgId?: string) {
    return orgId ? api.headers({ "x-zitadel-orgid": orgId }) : api;
  }

  interface RawUserGrantSearchResult {
    id: string;
    userId: string;
    roleKeys?: string[];
    details?: { sequence?: string; creationDate?: string };
    displayName?: string;
    email?: string;
  }

  function mapGrantEntry(grant: RawUserGrantSearchResult): ZitadelUserGrantEntry {
    return {
      grantId: grant.id ?? grant.userId,
      userId: grant.userId,
      roles: grant.roleKeys ?? [],
      displayName: grant.displayName ?? "",
      email: grant.email ?? "",
      createdAt: new Date(grant.details?.creationDate ?? 0),
    };
  }

  /**
   * List all user grants visible from the given org context, optionally
   * filtered server-side by role.
   *
   * With every user living in the project-owning (platform) org, pass
   * `roleKey` when enumerating that org's admins — without the filter the
   * search scans every granted org's user grants. For member listing on a
   * granted org, prefer `listMembersByProjectGrant`.
   */
  async function listOrgMembers(
    orgId: string,
    options: { roleKey?: string } = {},
  ): Promise<Result<ZitadelUserGrantEntry[], ZitadelApiError>> {
    return tryRequest(async () => {
      const queries: unknown[] = [];
      if (options.roleKey) {
        queries.push({ roleKeyQuery: { roleKey: options.roleKey } });
      }
      const body = queries.length > 0 ? { queries } : {};
      const data = (await withOrg(orgId)
        .url("/management/v1/users/grants/_search")
        .post(body)) as { result?: RawUserGrantSearchResult[] };

      return { ok: true, value: (data.result ?? []).map(mapGrantEntry) };
    });
  }

  /**
   * List all members of a granted org by querying user grants on its project
   * grant. Use this instead of `listOrgMembers(grantedOrgId)` when users live
   * in the project-owning org — they are no longer enumerable from the
   * granted org itself.
   *
   * Org context is the GRANTED org. Zitadel's user-grant search adds an
   * implicit `resourceOwner = x-zitadel-orgid` filter, and cross-org user
   * grants have ResourceOwner = grantedOrgId.
   */
  async function listMembersByProjectGrant(params: {
    grantedOrgId: string;
    projectGrantId: string;
  }): Promise<Result<ZitadelUserGrantEntry[], ZitadelApiError>> {
    return tryRequest(async () => {
      const data = (await withOrg(params.grantedOrgId)
        .url("/management/v1/users/grants/_search")
        .post({
          queries: [{ projectGrantIdQuery: { projectGrantId: params.projectGrantId } }],
        })) as { result?: RawUserGrantSearchResult[] };

      return { ok: true, value: (data.result ?? []).map(mapGrantEntry) };
    });
  }

  /**
   * Look up the existing project grant id for a granted org without touching
   * its role assignments. Returns null when no grant exists yet.
   *
   * Use this for read paths that need the projectGrantId (member listing,
   * single-user grant lookup). Write paths should call `syncProjectGrant`,
   * which is idempotent and additionally keeps `roleKeys` in sync with the
   * project's roles.
   */
  async function getProjectGrantId(params: {
    projectId: string;
    projectOwnerOrgId: string;
    grantedOrgId: string;
  }): Promise<Result<{ grantId: string } | null, ZitadelApiError>> {
    return tryRequest(async () => {
      const existing = (await withOrg(params.projectOwnerOrgId)
        .url(`/management/v1/projects/${params.projectId}/grants/_search`)
        .post({})) as {
        result?: Array<{ grantId: string; grantedOrgId: string }>;
      };
      const match = existing.result?.find((g) => g.grantedOrgId === params.grantedOrgId);
      if (!match) return { ok: true, value: null };
      return { ok: true, value: { grantId: match.grantId } };
    });
  }

  /**
   * Look up a single user's grant on a granted org's project grant. Returns
   * null when the user has no grant there. Suited to auth paths that re-check
   * a user's org access per request.
   *
   * The email/displayName fields are populated when Zitadel includes them on
   * the grant search payload — best-effort, callers should fall back to
   * `getUserById` if they need guaranteed presence.
   */
  async function findUserGrant(params: {
    grantedOrgId: string;
    projectGrantId: string;
    userId: string;
  }): Promise<
    Result<
      {
        grantId: string;
        role: string;
        email: string;
        displayName: string;
      } | null,
      ZitadelApiError
    >
  > {
    return tryRequest(async () => {
      const data = (await withOrg(params.grantedOrgId)
        .url("/management/v1/users/grants/_search")
        .post({
          queries: [
            { userIdQuery: { userId: params.userId } },
            { projectGrantIdQuery: { projectGrantId: params.projectGrantId } },
          ],
        })) as { result?: RawUserGrantSearchResult[] };

      const grant = data.result?.[0];
      if (!grant) return { ok: true, value: null };
      return {
        ok: true,
        value: {
          grantId: grant.id ?? grant.userId,
          role: grant.roleKeys?.[0] ?? "member",
          email: grant.email ?? "",
          displayName: grant.displayName ?? "",
        },
      };
    });
  }

  /**
   * List all role keys defined on a project.
   *
   * Must be called with x-zitadel-orgid set to the project's owning org.
   */
  async function listProjectRoles(params: {
    projectId: string;
    projectOwnerOrgId: string;
  }): Promise<Result<string[], ZitadelApiError>> {
    return tryRequest(async () => {
      const data = (await withOrg(params.projectOwnerOrgId)
        .url(`/management/v1/projects/${params.projectId}/roles/_search`)
        .post({})) as { result?: Array<{ key: string }> };
      return { ok: true, value: (data.result ?? []).map((r) => r.key) };
    });
  }

  /**
   * Upsert a project grant from the project-owning org to the target org so
   * that its `roleKeys` always equals (all project roles −
   * `platformOnlyRoles`).
   *
   * An empty `roleKeys` on a Zitadel project grant means "no roles available"
   * (not "all roles"), so we always pass the full set explicitly and keep it
   * in sync on every write. This is what makes adding a new role to the
   * project auto-propagate to existing granted orgs on their next invite /
   * role change.
   */
  async function syncProjectGrant(params: {
    projectId: string;
    projectOwnerOrgId: string;
    grantedOrgId: string;
  }): Promise<Result<{ grantId: string }, ZitadelApiError>> {
    return tryRequest(async () => {
      const rolesResult = await listProjectRoles({
        projectId: params.projectId,
        projectOwnerOrgId: params.projectOwnerOrgId,
      });
      if (!rolesResult.ok) return rolesResult;
      const desiredRoles = rolesResult.value
        .filter((r) => !platformOnlyRoles.includes(r))
        .sort();

      // Advisory 10014: x-zitadel-orgid must be the project OWNER when touching its grants.
      const existing = (await withOrg(params.projectOwnerOrgId)
        .url(`/management/v1/projects/${params.projectId}/grants/_search`)
        .post({})) as {
        result?: Array<{ grantId: string; grantedOrgId: string; roleKeys?: string[] }>;
      };
      const match = existing.result?.find((g) => g.grantedOrgId === params.grantedOrgId);

      if (!match) {
        const created = (await withOrg(params.projectOwnerOrgId)
          .url(`/management/v1/projects/${params.projectId}/grants`)
          .post({
            grantedOrgId: params.grantedOrgId,
            roleKeys: desiredRoles,
          })) as { grantId?: string };
        if (!created.grantId) {
          return {
            ok: false,
            error: {
              key: "missing_field",
              message: "Zitadel did not return a grantId for project grant",
            },
          };
        }
        return { ok: true, value: { grantId: created.grantId } };
      }

      const existingSorted = (match.roleKeys ?? []).slice().sort();
      const unchanged =
        existingSorted.length === desiredRoles.length &&
        existingSorted.every((r, i) => r === desiredRoles[i]);
      if (unchanged) return { ok: true, value: { grantId: match.grantId } };

      // Zitadel returns HTTP 400 with "NoChangesFoundc" when the PUT would be a
      // no-op. This happens when the _search response omits roleKeys but the
      // actual grant already has the roles we're about to set. Treat it as a
      // successful no-op rather than a failure.
      try {
        await withOrg(params.projectOwnerOrgId)
          .url(`/management/v1/projects/${params.projectId}/grants/${match.grantId}`)
          .put({ roleKeys: desiredRoles });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("NoChangesFoundc")) {
          return { ok: false, error: classifyZitadelError(err) };
        }
      }
      return { ok: true, value: { grantId: match.grantId } };
    });
  }

  /**
   * Grant a user membership in an organization, creating the Zitadel user if
   * needed.
   *
   * Users live in the **project-owning org** — that is where every user is
   * searched-or-created by email. The `orgId` parameter identifies the org
   * that should receive a user grant on the shared project.
   *
   * - Cross-org invite (`projectOwnerOrgId !== orgId`): user lives in
   *   `projectOwnerOrgId`; the user grant references the project grant that
   *   delegates the shared project to `orgId`.
   * - Same-org invite (`projectOwnerOrgId` is omitted or equals `orgId`):
   *   platform-admin path. Both user and grant live in the owning org and the
   *   grant is created directly against `projectId` with no project grant.
   *
   * Despite the name, no user is created in `orgId` — the unit of work is
   * "grant org access".
   */
  async function inviteUserToOrg(params: {
    orgId: string;
    projectId: string;
    /** Org that owns the shared project — also the org where users live. Required for cross-org invites. */
    projectOwnerOrgId?: string;
    email: string;
    role: string;
  }): Promise<Result<{ userId: string }, ZitadelApiError>> {
    return tryRequest(async () => {
      const userHomeOrgId = params.projectOwnerOrgId ?? params.orgId;

      // Search for existing user by email in the user directory (owning org).
      const searchResult = (await withOrg(userHomeOrgId)
        .url("/v2/users")
        .post({ queries: [{ emailQuery: { emailAddress: params.email } }] })) as {
        result?: Array<{ userId: string }>;
      };

      let userId: string;

      if (searchResult.result?.length) {
        userId = searchResult.result[0]!.userId;
      } else {
        // Zitadel's AddHumanUserRequest requires a non-empty givenName (and familyName).
        // We only have an email at invite time, so derive placeholders from the local part.
        const localPart = params.email.split("@")[0] || params.email;
        const createResult = (await withOrg(userHomeOrgId)
          .url("/v2/users/human")
          .post({
            email: { email: params.email, isVerified: false },
            profile: {
              givenName: localPart,
              familyName: localPart,
              displayName: params.email,
            },
            organization: { org: { id: userHomeOrgId } },
          })) as { userId: string };
        userId = createResult.userId;
      }

      // Cross-org invite: the project must be granted to the target org before a user
      // grant referencing it can be created. Same-org invites (platform admins) skip this.
      const crossOrg = params.projectOwnerOrgId && params.projectOwnerOrgId !== params.orgId;

      const grantBody: Record<string, unknown> = {
        projectId: params.projectId,
        roleKeys: [params.role],
      };
      if (crossOrg) {
        const syncResult = await syncProjectGrant({
          projectId: params.projectId,
          projectOwnerOrgId: params.projectOwnerOrgId!,
          grantedOrgId: params.orgId,
        });
        if (!syncResult.ok) return syncResult;
        grantBody.projectGrantId = syncResult.value.grantId;
      }

      // User grant write context: the GRANTED org. Zitadel sets the new
      // grant's ResourceOwner from x-zitadel-orgid, and the precondition
      // check matches it against `projectGrant.grantedOrgId`. Using the user's
      // home org here yields "Grant not found (COMMAND-4m9ff)" for cross-org.
      // For same-org admin invites, params.orgId == userHomeOrgId.
      await withOrg(params.orgId).url(`/management/v1/users/${userId}/grants`).post(grantBody);

      return { ok: true, value: { userId } };
    });
  }

  /**
   * Remove a user's only grant in an org, looked up by userId.
   *
   * For flows that only carry a userId. When the grantId is known, prefer
   * `removeUserGrant`.
   */
  async function removeOrgMemberByUserId(
    orgId: string,
    userId: string,
  ): Promise<Result<void, ZitadelApiError>> {
    return tryRequest(async () => {
      const grants = (await withOrg(orgId)
        .url("/management/v1/users/grants/_search")
        .post({
          queries: [{ userIdQuery: { userId } }],
        })) as { result?: Array<{ id: string; userId: string }> };

      const grant = grants.result?.[0];
      if (!grant) {
        return {
          ok: false,
          error: { key: "not_found", message: "Member not found" },
        };
      }

      await withOrg(orgId).url(`/management/v1/users/${userId}/grants/${grant.id}`).delete();

      return { ok: true, value: undefined };
    });
  }

  /**
   * Delete a specific user grant by id.
   */
  async function removeUserGrant(params: {
    orgId: string;
    userId: string;
    grantId: string;
  }): Promise<Result<void, ZitadelApiError>> {
    return tryRequest(async () => {
      await withOrg(params.orgId)
        .url(`/management/v1/users/${params.userId}/grants/${params.grantId}`)
        .delete();
      return { ok: true, value: undefined };
    });
  }

  /**
   * Update a specific user grant's roles by id.
   */
  async function updateUserGrant(params: {
    orgId: string;
    userId: string;
    grantId: string;
    roles: string[];
  }): Promise<Result<void, ZitadelApiError>> {
    return tryRequest(async () => {
      await withOrg(params.orgId)
        .url(`/management/v1/users/${params.userId}/grants/${params.grantId}`)
        .put({ roleKeys: params.roles });
      return { ok: true, value: undefined };
    });
  }

  interface ZitadelRawOrg {
    id: string;
    name: string;
    primaryDomain: string;
    details?: { creationDate?: string };
  }

  /**
   * List organizations the service account has access to.
   * Supports optional server-side filtering by primary domain and/or name.
   */
  async function listOrganizations(
    params: { domain?: string; name?: string } = {},
  ): Promise<Result<Array<{ id: string; name: string; primaryDomain: string }>, ZitadelApiError>> {
    return tryRequest(async () => {
      const body: Record<string, unknown> = {};
      const queries: Record<string, unknown>[] = [];
      if (params.domain) {
        queries.push({
          domainQuery: { domain: params.domain, method: "TEXT_QUERY_METHOD_EQUALS" },
        });
      }
      if (params.name) {
        // IGNORE_CASE guards against casing drift between a typed name and
        // the stored org name when matching orphaned orgs.
        queries.push({
          nameQuery: { name: params.name, method: "TEXT_QUERY_METHOD_EQUALS_IGNORE_CASE" },
        });
      }
      if (queries.length > 0) {
        body.queries = queries;
      }

      const data = (await api.url("/v2/organizations/_search").post(body)) as {
        result?: ZitadelRawOrg[];
      };

      const orgs = (data.result ?? []).map((org) => ({
        id: org.id,
        name: org.name,
        primaryDomain: org.primaryDomain,
      }));
      return { ok: true, value: orgs };
    });
  }

  /**
   * Create a new organization. Returns the Zitadel-generated org id.
   */
  async function createOrganization(params: {
    name: string;
  }): Promise<Result<{ id: string }, ZitadelApiError>> {
    return tryRequest(async () => {
      const data = (await api.url("/v2/organizations").post({ name: params.name })) as {
        organizationId?: string;
      };
      if (!data.organizationId) {
        return {
          ok: false,
          error: {
            key: "missing_field",
            message: "Zitadel did not return an organizationId",
          },
        };
      }
      return { ok: true, value: { id: data.organizationId } };
    });
  }

  /**
   * Delete an organization by id. Useful for compensating transactions when a
   * local insert fails after a Zitadel org was created.
   *
   * Uses the v1 management API (`DELETE /management/v1/orgs/me`) because the
   * v2 `DELETE /v2/organizations/{id}` endpoint is not available on all
   * Zitadel versions. The v1 endpoint requires `x-zitadel-orgid` to identify
   * the target organization.
   */
  async function deleteOrganization(orgId: string): Promise<Result<void, ZitadelApiError>> {
    return tryRequest(async () => {
      await withOrg(orgId).url("/management/v1/orgs/me").delete();
      return { ok: true, value: undefined };
    });
  }

  interface ZitadelRawUser {
    userId: string;
    state?: string;
    username?: string;
    preferredLoginName?: string;
    human?: {
      profile?: {
        givenName?: string;
        familyName?: string;
        displayName?: string;
        avatarUrl?: string;
        preferredLanguage?: string;
      };
      email?: { email?: string; isVerified?: boolean };
    };
    details?: { creationDate?: string };
  }

  function mapRawUser(raw: ZitadelRawUser): ZitadelUser {
    const profile = raw.human?.profile;
    const email = raw.human?.email?.email ?? raw.preferredLoginName ?? "";
    const fullName = [profile?.givenName, profile?.familyName].filter(Boolean).join(" ");
    const displayName = profile?.displayName || fullName || raw.username || email;
    return {
      userId: raw.userId,
      email,
      name: displayName,
      displayName,
      givenName: profile?.givenName ?? null,
      familyName: profile?.familyName ?? null,
      avatarUrl: profile?.avatarUrl ?? null,
      preferredLanguage: profile?.preferredLanguage ?? null,
      state: raw.state ?? "USER_STATE_UNSPECIFIED",
      createdAt: new Date(raw.details?.creationDate ?? 0),
    };
  }

  /**
   * List all users in the Zitadel instance. Supports optional free-text filter.
   */
  async function listAllUsers(
    params: {
      query?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<Result<{ items: ZitadelUser[]; totalResult: number }, ZitadelApiError>> {
    return tryRequest(async () => {
      const queries: unknown[] = [];
      if (params.query) {
        const method: "CONTAINS" | "EQUALS" = "CONTAINS";
        queries.push({
          orQuery: {
            queries: [
              { emailQuery: { emailAddress: params.query, method } },
              { displayNameQuery: { displayName: params.query, method } },
              { userNameQuery: { userName: params.query, method } },
            ],
          },
        });
      }

      const body: Record<string, unknown> = {
        query: {
          offset: String(params.offset ?? 0),
          limit: params.limit ?? 100,
          asc: true,
        },
      };
      if (queries.length > 0) {
        body.queries = queries;
      }

      const data = (await api.url("/v2/users").post(body)) as {
        result?: ZitadelRawUser[];
        details?: { totalResult?: string };
      };

      return {
        ok: true,
        value: {
          items: (data.result ?? []).map(mapRawUser),
          totalResult: Number(data.details?.totalResult ?? 0),
        },
      };
    });
  }

  /**
   * Fetch a single user by their Zitadel user id. Returns
   * `Result.error('not_found')` if Zitadel responds with 404.
   */
  async function getUserById(userId: string): Promise<Result<ZitadelUser, ZitadelApiError>> {
    return tryRequest(async () => {
      const data = (await api.url(`/v2/users/${userId}`).get()) as {
        user?: ZitadelRawUser;
      };
      if (!data.user) {
        return {
          ok: false,
          error: { key: "not_found", message: `User '${userId}' not found` },
        };
      }
      return { ok: true, value: mapRawUser(data.user) };
    });
  }

  /**
   * Update a human user's profile fields.
   *
   * Zitadel's `PUT /v2/users/human/{userId}` requires `givenName` and
   * `familyName` inside `profile` whenever profile is set, so we fetch the
   * current values and merge in the patch. Extend the patch type as more
   * editable fields are needed.
   */
  async function updateHumanUserProfile(params: {
    userId: string;
    patch: { preferredLanguage?: string };
  }): Promise<Result<void, ZitadelApiError>> {
    const current = await getUserById(params.userId);
    if (!current.ok) return current;

    const profile: Record<string, string> = {
      givenName: current.value.givenName ?? current.value.displayName ?? "",
      familyName: current.value.familyName ?? current.value.displayName ?? "",
      displayName: current.value.displayName,
    };
    if (params.patch.preferredLanguage !== undefined) {
      profile.preferredLanguage = params.patch.preferredLanguage;
    } else if (current.value.preferredLanguage) {
      profile.preferredLanguage = current.value.preferredLanguage;
    }

    return tryRequest(async () => {
      await api.url(`/v2/users/human/${params.userId}`).put({ profile });
      return { ok: true, value: undefined };
    });
  }

  /**
   * List every project grant held by a user across all organizations.
   *
   * `/management/v1/users/grants/_search` is org-scoped — the caller and target user
   * must share an org. To find grants across every org, we iterate all orgs the PAT
   * can see and query each one with the x-zitadel-orgid header set.
   *
   * Per-org failures are logged and skipped (best-effort aggregation). The outer
   * `listOrganizations` failure surfaces as `Result.error`.
   */
  async function listUserGrants(userId: string): Promise<Result<ZitadelUserGrant[], ZitadelApiError>> {
    const orgsResult = await listOrganizations();
    if (!orgsResult.ok) return orgsResult;
    const orgs = orgsResult.value;

    const perOrg = await Promise.all(
      orgs.map(async (org) => {
        try {
          const data = (await withOrg(org.id)
            .url("/management/v1/users/grants/_search")
            .post({ queries: [{ userIdQuery: { userId } }] })) as {
            result?: Array<{
              id: string;
              userId: string;
              orgId: string;
              orgName?: string;
              orgDomain?: string;
              projectId: string;
              roleKeys?: string[];
              details?: { creationDate?: string };
            }>;
          };
          return (data.result ?? []).map(
            (g): ZitadelUserGrant => ({
              grantId: g.id,
              userId: g.userId,
              orgId: g.orgId,
              orgName: g.orgName ?? org.name,
              orgPrimaryDomain: g.orgDomain ?? org.primaryDomain,
              projectId: g.projectId,
              roles: g.roleKeys ?? [],
              createdAt: new Date(g.details?.creationDate ?? 0),
            }),
          );
        } catch (err) {
          logger.warn("failed to list user grants for org", {
            orgId: org.id,
            userId,
            error: err instanceof Error ? err.message : String(err),
          });
          return [];
        }
      }),
    );

    return { ok: true, value: perOrg.flat() };
  }

  return {
    listOrgMembers,
    listMembersByProjectGrant,
    getProjectGrantId,
    findUserGrant,
    inviteUserToOrg,
    removeOrgMemberByUserId,
    removeUserGrant,
    updateUserGrant,
    listOrganizations,
    createOrganization,
    deleteOrganization,
    listAllUsers,
    getUserById,
    updateHumanUserProfile,
    listUserGrants,
    listProjectRoles,
    syncProjectGrant,
  };
}

export type ZitadelManagementClient = ReturnType<typeof createZitadelManagementClient>;
