/**
 * Zitadel scope presets for {@link createUserManagerFactory}.
 *
 * The URN scopes request the resource-owner (organization) claim and the
 * project role grants; `offline_access` requests a refresh token.
 */
export const ZITADEL_ORG_PROJECT_SCOPE =
  'openid profile email urn:zitadel:iam:user:resourceowner urn:zitadel:iam:org:project:roles offline_access';

/**
 * Zitadel only accepts standard OIDC scopes on the refresh-token grant —
 * sending `offline_access` or the `urn:zitadel:*` scopes returns
 * `invalid_scope` even though they were granted at the initial auth. The
 * URN-based claims still need to land in the refreshed access token; that
 * depends on "Assert Roles on Authentication" being enabled at the Zitadel
 * project level.
 */
export const ZITADEL_REFRESH_TOKEN_ALLOWED_SCOPE = 'openid profile email';
