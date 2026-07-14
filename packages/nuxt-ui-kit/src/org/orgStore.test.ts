import { describe, expect, it, vi } from 'vitest';
import { createOrgStoreCore } from './orgStore.ts';

interface Org {
  id: string;
  slug: string;
  isDisabled: boolean;
}

const ORGS: Org[] = [
  { id: '1', slug: 'acme', isDisabled: false },
  { id: '2', slug: 'globex', isDisabled: true },
];

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

const make = (opts: {
  fetch?: () => Promise<{ items: Org[] } | { error: unknown }>;
  storage?: ReturnType<typeof fakeStorage>;
}) =>
  createOrgStoreCore<Org>({
    fetchOrganizations: opts.fetch ?? (async () => ({ items: ORGS })),
    getSlug: (org) => org.slug,
    persistenceKey: 'currentTenantSlug',
    storage: opts.storage ?? fakeStorage(),
  });

describe('createOrgStoreCore', () => {
  it('fetches organizations and resolves the current one by slug', async () => {
    const store = make({});
    await store.fetchOrganizations();
    store.setCurrent('acme');
    expect(store.organizations.value).toHaveLength(2);
    expect(store.currentOrganization.value?.id).toBe('1');
  });

  it('surfaces fetch errors without clearing previous data', async () => {
    let fail = false;
    const store = make({
      fetch: async () => (fail ? { error: { status: 500 } } : { items: ORGS }),
    });
    await store.fetchOrganizations();
    fail = true;
    await store.fetchOrganizations();
    expect(store.fetchError.value).toEqual({ status: 500 });
    expect(store.organizations.value).toHaveLength(2);
  });

  it('clears the fetch error on the next successful fetch', async () => {
    let fail = true;
    const store = make({
      fetch: async () => (fail ? { error: 'boom' } : { items: ORGS }),
    });
    await store.fetchOrganizations();
    expect(store.fetchError.value).toBe('boom');
    fail = false;
    await store.fetchOrganizations();
    expect(store.fetchError.value).toBeNull();
  });

  it('revokes the current selection when access to it was lost', async () => {
    const storage = fakeStorage();
    const store = make({
      fetch: async () => ({ items: [ORGS[1]!] }),
      storage,
    });
    store.setCurrent('acme');
    await store.fetchOrganizations();
    expect(store.currentSlug.value).toBeNull();
    expect(storage.dump()).toEqual({});
  });

  it('persists and restores the selection', () => {
    const storage = fakeStorage();
    const store = make({ storage });
    store.setCurrent('acme');
    expect(storage.dump()).toEqual({ currentTenantSlug: 'acme' });

    const restored = make({ storage });
    restored.loadPersisted();
    expect(restored.currentSlug.value).toBe('acme');
  });

  it('clearing the selection removes the persisted key', () => {
    const storage = fakeStorage({ currentTenantSlug: 'acme' });
    const store = make({ storage });
    store.loadPersisted();
    store.setCurrent(null);
    expect(store.currentSlug.value).toBeNull();
    expect(storage.dump()).toEqual({});
  });

  it('currentOrganization is null when nothing is selected', async () => {
    const store = make({});
    await store.fetchOrganizations();
    expect(store.currentOrganization.value).toBeNull();
  });

  it('tracks loading state around the fetch', async () => {
    let resolve!: (v: { items: Org[] }) => void;
    const store = make({ fetch: () => new Promise((r) => (resolve = r)) });
    const pending = store.fetchOrganizations();
    expect(store.loading.value).toBe(true);
    resolve({ items: ORGS });
    await pending;
    expect(store.loading.value).toBe(false);
  });
});
