/**
 * The kit's cross-page AI progress core wrapped in the app's own Pinia store —
 * the same core-in-a-store pattern as `stores/auth.ts`.
 *
 * `createAiProgressCore` owns tracking, the poll-while-active loop, and the
 * `completionSignal`/`appliedSignal` counters pages watch; the app injects the
 * one transport function it needs (`fetchWorkflowStatus`, wired to the
 * server's snapshot projection) and the dialog-request shape (unused by this
 * demo — the brief modal is opened directly from the contacts table).
 */
import { defineStore } from 'pinia'
import { createAiProgressCore } from '@octabits-io/nuxt-ui-kit/ai'
import type { AiWorkflowStatusSnapshot } from '@octabits-io/nuxt-ui-kit/ai'
import { useApi } from '~/composables/useApi'

/** Dialog-request channel shape (generic seam; this demo does not use it). */
export interface AiDialogRequest {
  workflowType: string
  entityRef: string
}

export const useAiProgressStore = defineStore('ai-progress', () => {
  const { api } = useApi()

  return createAiProgressCore<AiDialogRequest>({
    fetchWorkflowStatus: async (workflowId: number): Promise<AiWorkflowStatusSnapshot | null> => {
      const { data, error } = await api.ai.workflows({ id: workflowId }).status.get()
      // `null` means "unknown this cycle" — the core keeps the last state and
      // retries on the next tick instead of flapping.
      if (error) return null
      return data
    },
  })
})
