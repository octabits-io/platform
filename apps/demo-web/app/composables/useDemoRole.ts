/**
 * The `x-demo-role` the API sees.
 *
 * Module-scoped singleton rather than a Pinia store: `useApi`'s `onRequest`
 * hook has to read it from outside any component/store context, and this keeps
 * that a plain function call. (A real app maps the role from a validated JWT
 * claim — see the demo server's `rbac.ts`.)
 */
import { ref, readonly } from 'vue'

export type DemoRole = 'admin' | 'viewer'

const STORAGE_KEY = 'demo-role'

const role = ref<DemoRole>('admin')

/** Read the current role — the seam `useApi`'s request hook calls. */
export function readDemoRole(): DemoRole {
  return role.value
}

export function useDemoRole() {
  function setRole(next: DemoRole) {
    role.value = next
    if (import.meta.client) localStorage.setItem(STORAGE_KEY, next)
  }

  function loadPersisted() {
    if (!import.meta.client) return
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'admin' || stored === 'viewer') role.value = stored
  }

  return { role: readonly(role), setRole, loadPersisted }
}
