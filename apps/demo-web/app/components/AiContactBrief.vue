<script setup lang="ts">
/**
 * The contact-brief workflow UI — the kit's `./ai` engine wired end to end.
 *
 * Every kit AI primitive appears once, with its transport injected from the
 * `hc` client:
 *   - `useAiWorkflowGuard` — mount-time rehydration (`checkFn` = latest run
 *     for this entity) + duplicate-safe `trigger` + terminal callbacks.
 *   - `useActiveAiWorkflowProbe` — disables the trigger while a run is in
 *     flight, even one started in another tab.
 *   - `useAiCardState` — derives the idle/active/failed chip from the
 *     cross-page progress store.
 *   - `AppProposalReviewCard` (kit SFC) — the review half of the loop. The run's
 *     last step stored a `Proposal` as its output; the card renders it (what
 *     each value replaces, editable, partially acceptable) and emits a
 *     `ProposalDecision`, which this component posts to the apply route. Apply
 *     and revert are server writes with an audit row; `appliedAt` comes back on
 *     the workflow itself, so the applied state survives a reload.
 * The progress store (`stores/aiProgress.ts`) is told about every trigger so
 * the navbar badge keeps tracking after this modal closes.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  useAiWorkflowGuard,
  useActiveAiWorkflowProbe,
  useAiCardState,
  type AiWorkflowData,
} from '@octabits-io/nuxt-ui-kit/ai'
import type { Proposal, ProposalDecision } from '@octabits-io/framework/proposal'
import { useApi } from '~/composables/useApi'
import { call } from '~/composables/useApiCall'
import { useApiError } from '~/composables/useApiError'
import { useAiProgressStore } from '~/stores/aiProgress'
import { CONTACT_BRIEF, type ContactBriefOutput } from '~/lib/aiWorkflows'

const props = defineProps<{
  contact: { id: string; name: string; email: string }
}>()

const emit = defineEmits<{ applied: [] }>()

const { t } = useI18n()
const { api } = useApi()
const { toastError } = useApiError()
const toast = useToast()
const progress = useAiProgressStore()

const entityRef = computed(() => `contact:${props.contact.id}`)

/**
 * One read serves both `checkFn` (rehydrate on mount) and `pollFn`: the
 * newest workflow for this entity. The casts narrow what the wire cannot
 * carry: the route types `output` as `unknown`, this workflow type produces
 * `ContactBriefOutput`.
 */
async function fetchLatest(): Promise<AiWorkflowData<ContactBriefOutput> | null> {
  const { data, error } = await call(api.ai.workflows.$get({
    query: { entityRef: entityRef.value, limit: '1' },
  }))
  if (error) return null
  return (data.items[0] ?? null) as AiWorkflowData<ContactBriefOutput> | null
}

const reviewDismissed = ref(false)

const guard = useAiWorkflowGuard<ContactBriefOutput>({
  checkFn: fetchLatest,
  pollFn: fetchLatest,
  onCompleted: () =>
    toast.add({ title: t('ai.brief.completedToast', { name: props.contact.name }), color: 'success' }),
  onFailed: () =>
    toast.add({ title: t('ai.brief.failedToast', { name: props.contact.name }), color: 'error' }),
})

const probe = useActiveAiWorkflowProbe({
  entityRef,
  fetchHasActive: async (ref) => {
    const { data, error } = await call(api.ai.workflows.active.$get({ query: { entityRef: ref } }))
    return error ? null : data.active
  },
})

const { cardState, dismissFailure } = useAiCardState(progress, entityRef, probe.hasActive)

async function start() {
  reviewDismissed.value = false
  await guard.trigger(async () => {
    const { data, error } = await call(api.ai.workflows.$post({
      json: { type: 'contact-brief', contactId: props.contact.id },
    }))
    // Throwing is the guard's abort signal (it returns false); surface first.
    if (error) { toastError(error); throw new Error(String(error.status)) }
    progress.track(data.workflowId, CONTACT_BRIEF.type, entityRef.value)
    void probe.refresh()
  })
}

async function cancelRun() {
  const id = guard.workflow.value?.id
  if (!id) return
  await guard.cancel(async () => {
    const { error } = await call(api.ai.workflows[':id'].cancel.$post({ param: { id: String(id) } }))
    if (error) toastError(error)
  })
  void probe.refresh()
}

// --- Review → apply → revert -------------------------------------------------

/** The run's stored proposal — what the card renders. */
const proposal = computed<Proposal | null>(() => guard.output.value?.propose ?? null)

/** Set by the server from its audit row; null until applied, null again after revert. */
const appliedAt = computed(() => guard.workflow.value?.appliedAt ?? null)

const showReview = computed(
  () => guard.isCompleted.value && proposal.value !== null && appliedAt.value === null && !reviewDismissed.value,
)

const applying = ref(false)
const reverting = ref(false)

async function applyDecision(decision: ProposalDecision) {
  const id = guard.workflow.value?.id
  if (!id) return
  applying.value = true
  try {
    const { data, error } = await call(api.ai.workflows[':id'].apply.$post({
      param: { id: String(id) },
      json: decision,
    }))
    if (error) {
      // Drift is the one expected refusal: the contact changed since the
      // proposal was made. Re-read so the reviewer sees the current run state.
      if (error.status === 409 && error.value.key === 'proposal_drift') {
        toast.add({ title: t('ai.brief.drift'), color: 'warning' })
        await guard.refresh()
      } else {
        toastError(error)
      }
      return
    }
    progress.markApplied(id)
    toast.add({
      title: t('ai.brief.applied', { notes: Object.keys(data.created).length }),
      color: 'success',
    })
    // `appliedAt` is projected from the audit row — one refresh picks it up.
    await guard.refresh()
    emit('applied')
  } finally {
    applying.value = false
  }
}

async function revertDecision() {
  const id = guard.workflow.value?.id
  if (!id) return
  reverting.value = true
  try {
    const { error } = await call(api.ai.workflows[':id'].revert.$post({ param: { id: String(id) } }))
    if (error) { toastError(error); return }
    toast.add({ title: t('ai.brief.reverted'), color: 'success' })
    await guard.refresh()
    emit('applied')
  } finally {
    reverting.value = false
  }
}

function dismissBrief() {
  const id = guard.workflow.value?.id
  if (id) progress.dismiss(id)
  reviewDismissed.value = true
  dismissFailure()
}

// --- Step display -----------------------------------------------------------

const STEP_ICONS: Record<string, string> = {
  pending: 'i-lucide-circle-dashed',
  running: 'i-lucide-loader-circle',
  completed: 'i-lucide-circle-check',
  failed: 'i-lucide-circle-x',
  skipped: 'i-lucide-circle-minus',
}

const steps = computed(() => guard.workflow.value?.steps ?? [])
</script>

<template>
  <div class="flex flex-col gap-4">
    <p class="text-sm text-muted">{{ t('ai.brief.intro') }}</p>

    <div class="flex items-center gap-2">
      <UButton
        :label="t('ai.brief.start')"
        icon="i-lucide-sparkles"
        :loading="guard.isChecking.value"
        :disabled="guard.isActive.value || probe.hasActive.value"
        @click="start"
      />
      <UButton
        v-if="guard.isActive.value"
        :label="t('ai.brief.cancel')"
        color="neutral"
        variant="outline"
        @click="cancelRun"
      />
      <UBadge v-if="cardState === 'active'" color="primary" variant="subtle">
        {{ t('ai.brief.running') }}
      </UBadge>
    </div>

    <!-- Live DAG view: fetch first, then summarize + followup in parallel, then propose. -->
    <div v-if="steps.length > 0" class="flex flex-col gap-2">
      <UProgress :model-value="guard.progress.value * 100" />
      <div class="text-xs font-medium text-muted">{{ t('ai.brief.steps') }}</div>
      <ul class="flex flex-col gap-1">
        <li v-for="step in steps" :key="step.id" class="flex items-center gap-2 text-sm">
          <UIcon
            :name="STEP_ICONS[step.status] ?? 'i-lucide-circle'"
            :class="[
              'size-4',
              step.status === 'completed' ? 'text-success'
              : step.status === 'failed' ? 'text-error'
              : step.status === 'running' ? 'animate-spin text-primary' : 'text-muted',
            ]"
          />
          <span>{{ step.key }}</span>
          <span v-if="step.dependencies.length > 0" class="text-xs text-muted">
            ← {{ step.dependencies.join(', ') }}
          </span>
        </li>
      </ul>
    </div>

    <UAlert
      v-if="guard.isFailed.value && !reviewDismissed"
      color="error"
      variant="subtle"
      :title="t('ai.brief.failed', { error: guard.error.value ?? '—' })"
      :close-button="{ color: 'error', variant: 'link' }"
      @close="dismissBrief"
    />
    <UAlert
      v-if="guard.isCancelled.value"
      color="warning"
      variant="subtle"
      :title="t('ai.brief.cancelled')"
    />

    <AppProposalReviewCard
      v-if="showReview && proposal"
      :proposal="proposal"
      :applying="applying"
      @apply="applyDecision"
      @dismiss="dismissBrief"
    />

    <!-- Applied: the audit row exists. Revert derives the inverse from it. -->
    <div
      v-else-if="appliedAt"
      class="flex flex-wrap items-center justify-between gap-2 rounded border border-default p-3 text-sm"
    >
      <span>
        <UIcon name="i-lucide-check" class="mr-1 size-4 text-success" />
        {{ t('ai.brief.appliedAt', { at: new Date(appliedAt).toLocaleString() }) }}
      </span>
      <UButton
        :label="t('ai.brief.revert')"
        color="neutral"
        variant="outline"
        size="sm"
        :loading="reverting"
        @click="revertDecision"
      />
    </div>
  </div>
</template>
