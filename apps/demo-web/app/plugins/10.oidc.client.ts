/**
 * Wire oidc-client-ts session events to app-side reactions.
 *
 * The kit classifies (`renew-failed` vs `session-expired` vs back-channel
 * signout); the copy, the toast, and the store reset stay here. With no IdP
 * these handlers are effectively dormant — but this is the real wiring a
 * consumer copies, so it is wired for real rather than stubbed.
 *
 * Two context notes, both plugin-specific rather than kit-specific:
 *   - `useI18n()` needs a component instance, so a plugin reads `i18n.global`.
 *   - `useToast()` needs the Nuxt app context; the handlers fire long after
 *     mount, so it is resolved lazily inside `runWithContext`.
 */
import {
  attachSessionLifecycleHandlers,
  createLoginRedirector,
} from '@octabits-io/nuxt-ui-kit'
import { i18n } from '~/lib/i18n'
import { getUserManager } from '~/lib/oidc'
import { useAuthStore } from '~/stores/auth'

export default defineNuxtPlugin((nuxtApp) => {
  const detach = attachSessionLifecycleHandlers(getUserManager(), {
    redirectToLogin: createLoginRedirector({ getUserManager }),
    onSessionLost: () => {
      useAuthStore().user = null
    },
    notify: (notice) => {
      const expired = notice.kind === 'session-expired'
      nuxtApp.runWithContext(() => {
        useToast().add({
          title: i18n.global.t(expired ? 'session.expired' : 'session.renewFailed'),
          color: expired ? 'error' : 'warning',
        })
      })
    },
  })

  // Vite HMR would otherwise stack a new listener set on every plugin reload.
  if (import.meta.hot) import.meta.hot.dispose(detach)
})
