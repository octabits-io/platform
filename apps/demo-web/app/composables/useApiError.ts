/**
 * Bind the kit's error messenger to this app's i18n instance.
 *
 * The kit maps `{ key, message }` bodies onto the `errors.*` /
 * `validation.fields.*` / `validation.messages.*` key convention and unwraps
 * Eden's `{ value }` error envelope; the locale file fulfils the convention.
 * Unmapped keys fall back to the server's own `message`, so a new server error
 * degrades to English prose rather than a missing-key crash.
 */
import { createApiErrorMessenger } from '@octabits-io/nuxt-ui-kit'
import { useI18n } from 'vue-i18n'

export function useApiError() {
  const { t, te } = useI18n()
  const messenger = createApiErrorMessenger({
    t: (key) => t(key),
    te: (key) => te(key),
  })

  const toast = useToast()

  /** Surface an API error as an error toast. Returns the resolved message. */
  function toastError(error: unknown): string {
    const message = messenger.getErrorMessage(error)
    toast.add({ title: message, color: 'error' })
    return message
  }

  return { ...messenger, toastError }
}
