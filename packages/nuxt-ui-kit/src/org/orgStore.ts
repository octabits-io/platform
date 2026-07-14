import { ref, computed, type Ref, type ComputedRef } from 'vue';

type OrgStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Result seam for the org fetch — mirrors an Eden Treaty `{ data, error }`. */
export type FetchOrganizationsResult<TOrg> =
  | { items: TOrg[]; error?: undefined }
  | { items?: undefined; error: unknown };

export interface OrgStoreCoreOptions<TOrg> {
  /**
   * Fetch the orgs the current user is granted. Return `{ items }` on
   * success or `{ error }` to surface a fetch failure (`fetchError`).
   */
  fetchOrganizations: () => Promise<FetchOrganizationsResult<TOrg>>;
  /** The org's URL/selection identity. */
  getSlug: (org: TOrg) => string;
  /** Storage key persisting the current selection. Default `currentOrgSlug`. */
  persistenceKey?: string;
  storage?: OrgStorage;
}

export interface OrgStoreCore<TOrg> {
  organizations: Ref<TOrg[]>;
  currentSlug: Ref<string | null>;
  currentOrganization: ComputedRef<TOrg | null>;
  loading: Ref<boolean>;
  fetchError: Ref<unknown>;
  /** Fetch grants; revokes the current selection if access was lost. */
  fetchOrganizations: () => Promise<void>;
  /** Select an org by slug (or clear with `null`); persists the choice. */
  setCurrent: (slug: string | null) => void;
  /** Restore the persisted selection (call once at app start). */
  loadPersisted: () => void;
}

/**
 * Reactive granted-organizations state + switching — the setup body of an
 * org/tenant store. Wrap it in the app's own store (and alias names there):
 *
 * ```ts
 * export const useTenantStore = defineStore('tenant', () => {
 *   const core = createOrgStoreCore<Tenant>({ fetchOrganizations, getSlug: t => t.slug })
 *   return { ...core, fetchTenants: core.fetchOrganizations }
 * })
 * ```
 */
export function createOrgStoreCore<TOrg>(
  options: OrgStoreCoreOptions<TOrg>,
): OrgStoreCore<TOrg> {
  const persistenceKey = options.persistenceKey ?? 'currentOrgSlug';
  const getStorage = () => options.storage ?? globalThis.localStorage;

  const organizations = ref<TOrg[]>([]) as Ref<TOrg[]>;
  const currentSlug = ref<string | null>(null);
  const loading = ref(false);
  const fetchError = ref<unknown>(null);

  const currentOrganization = computed(() => {
    if (!currentSlug.value) return null;
    return (
      organizations.value.find(
        (org) => options.getSlug(org) === currentSlug.value,
      ) ?? null
    );
  });

  async function fetchOrganizations() {
    loading.value = true;
    fetchError.value = null;
    try {
      const result = await options.fetchOrganizations();
      if (result.items === undefined) {
        fetchError.value = result.error;
        return;
      }
      organizations.value = result.items;

      // Access to the previously selected org may have been revoked.
      if (currentSlug.value) {
        const hasAccess = organizations.value.some(
          (org) => options.getSlug(org) === currentSlug.value,
        );
        if (!hasAccess) {
          setCurrent(null);
        }
      }
    } finally {
      loading.value = false;
    }
  }

  function setCurrent(slug: string | null) {
    currentSlug.value = slug;
    if (slug) {
      getStorage().setItem(persistenceKey, slug);
    } else {
      getStorage().removeItem(persistenceKey);
    }
  }

  function loadPersisted() {
    const stored = getStorage().getItem(persistenceKey);
    if (stored) {
      currentSlug.value = stored;
    }
  }

  return {
    organizations,
    currentSlug,
    currentOrganization,
    loading,
    fetchError,
    fetchOrganizations,
    setCurrent,
    loadPersisted,
  };
}
