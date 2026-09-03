<script setup lang="ts">
// Shipped as source: the consumer's Vite compiles this SFC. All imports are
// explicit — no reliance on the consumer's auto-import configuration.
//
// The generic review surface for a `Proposal`. It replaces the per-workflow
// result component: everything it needs to render — what each slot holds now,
// what is proposed, which control edits it, what the limits are — arrives on
// the proposal itself, so this component knows nothing about listings,
// locales, places, or any particular workflow.
//
// It renders all four operation kinds, because a review that silently omits
// the creates in a proposal is worse than no review:
//
//   update   the current value, the proposed one, and an editor
//   create   the new row, with the note when it is really a link to an
//            existing record
//   delete   what is about to be lost
//   reorder  the sequence, before and after
//
// What it deliberately does NOT own:
//   * the rich-text editor — supplied through the `richtext` slot, so the host
//     keeps its own editor (and this kit stays free of a TipTap dependency)
//   * how a decision is committed — emitted as a `ProposalDecision`, which the
//     host posts to whatever endpoint applies it
//
// i18n key contract: ai.review.* (title, apply, dismiss, currentValue,
// currentEmpty, noChanges, charsRecommended, derivedFrom, willCreate,
// willDelete, willReorder, linksExisting, skipped, dangling).
import { computed, ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import UCard from '@nuxt/ui/components/Card.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import UTextarea from '@nuxt/ui/components/Textarea.vue'
import UCheckbox from '@nuxt/ui/components/Checkbox.vue'
import UTabs from '@nuxt/ui/components/Tabs.vue'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UBadge from '@nuxt/ui/components/Badge.vue'
import {
  danglingAfterDecision,
  formatPath,
  operationsForVariant,
  proposalVariants,
  summarize,
} from '@octabits-io/framework/proposal'
import type { JsonValue, Proposal, ProposalDecision, ProposedOperation } from '@octabits-io/framework/proposal'

const props = withDefaults(
  defineProps<{
    proposal: Proposal
    applying?: boolean
    /** Label for a variant key ('de' → 'Deutsch'). Identity by default. */
    variantLabel?: (variant: string) => string
    /**
     * One readable line for a structured value — what the host shows as the
     * current value of a rich-text or JSON-shaped slot. Without it a document
     * renders as its JSON, which is faithful and unreadable. Return null or
     * undefined to fall back to the default preview.
     */
    formatValue?: (value: JsonValue, operation: ProposedOperation) => string | null | undefined
  }>(),
  { applying: false, variantLabel: undefined, formatValue: undefined },
)

const emit = defineEmits<{
  apply: [decision: ProposalDecision]
  dismiss: []
}>()

const { t } = useI18n()

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

const variants = computed(() => proposalVariants(props.proposal))

const activeVariant = ref<string | undefined>(undefined)
watchEffect(() => {
  if (variants.value.length === 0) {
    activeVariant.value = undefined
    return
  }
  if (activeVariant.value == null || !variants.value.includes(activeVariant.value)) {
    activeVariant.value = variants.value[0]
  }
})

const variantTabs = computed(() =>
  variants.value.map((variant) => ({
    label: props.variantLabel?.(variant) ?? variant,
    value: variant,
  })),
)

/** Un-varianted operations appear under every tab — see `operationsForVariant`. */
const visible = computed(() => operationsForVariant(props.proposal, activeVariant.value))

const counts = computed(() => summarize(props.proposal))

// ---------------------------------------------------------------------------
// Selection and edits, keyed by operation id
// ---------------------------------------------------------------------------

/**
 * Selection defaults to accepted: the reviewer is confirming a set that was
 * already filtered down to real changes, so opening with everything off would
 * make the common case — "yes, all of this" — the laborious one.
 */
const accepted = ref<Record<string, boolean>>({})
const edited = ref<Record<string, JsonValue>>({})

function valueOf(op: ProposedOperation): JsonValue | undefined {
  if (op.op === 'update') return op.proposed
  if (op.op === 'create') return op.value
  return undefined
}

watchEffect(() => {
  for (const op of props.proposal.operations) {
    if (!(op.id in accepted.value)) accepted.value[op.id] = true
    const value = valueOf(op)
    if (value !== undefined && !(op.id in edited.value)) edited.value[op.id] = value
  }
})

const acceptedIds = computed(() =>
  props.proposal.operations.filter((op) => accepted.value[op.id]).map((op) => op.id),
)

/**
 * Children kept while their parent was rejected. Surfaced rather than silently
 * dropped: in a tree review this is an ordinary mistake, and the operations it
 * produces cannot be applied.
 */
const dangling = computed(() =>
  danglingAfterDecision(props.proposal, { accepted: acceptedIds.value }),
)

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function labelFor(op: ProposedOperation): string {
  if (op.display?.labelKey) return t(op.display.labelKey)
  if (op.display?.label) return op.display.label
  if (op.op === 'update') return formatPath(op.path)
  if (op.op === 'create') return op.collection
  if (op.op === 'delete') return op.target.kind === 'entity' ? (op.target.label ?? op.target.id) : op.target.ref
  return op.collection
}

function textValue(id: string): string {
  const value = edited.value[id]
  return typeof value === 'string' ? value : ''
}

function setTextValue(id: string, value: string) {
  edited.value[id] = value
}

/**
 * A value as one readable line. The host's `formatValue` goes first (it knows
 * its document shapes); structured values otherwise fall back to compact JSON.
 */
function preview(value: JsonValue | undefined, operation: ProposedOperation): string | null {
  if (value === undefined || value === null || value === '') return null
  const formatted = props.formatValue?.(value, operation)
  if (formatted != null) return formatted === '' ? null : formatted
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function controlOf(op: ProposedOperation): string {
  return op.display?.control ?? (typeof valueOf(op) === 'string' ? 'text' : 'json')
}

const costLabel = computed(() => {
  const micros = props.proposal.provenance?.costMicros
  return micros == null ? null : `${(micros / 1_000_000).toFixed(4)} USD`
})

function submit() {
  const decision: ProposalDecision = { accepted: [], edits: [] }

  for (const op of props.proposal.operations) {
    if (!accepted.value[op.id]) continue
    decision.accepted.push(op.id)

    const value = edited.value[op.id]
    if (value !== undefined && valueOf(op) !== undefined) {
      decision.edits?.push({ id: op.id, value })
    }
  }

  emit('apply', decision)
}
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center">
          <UIcon name="i-lucide-sparkles" class="mr-2 size-4 text-primary" />
          <span class="font-medium">{{ t('ai.review.title') }}</span>
        </div>
        <div class="flex items-center gap-1.5">
          <UBadge v-if="counts.update" color="primary" variant="subtle" size="sm">
            {{ counts.update }} {{ t('ai.review.willUpdate') }}
          </UBadge>
          <UBadge v-if="counts.create" color="success" variant="subtle" size="sm">
            {{ counts.create }} {{ t('ai.review.willCreate') }}
          </UBadge>
          <UBadge v-if="counts.delete" color="error" variant="subtle" size="sm">
            {{ counts.delete }} {{ t('ai.review.willDelete') }}
          </UBadge>
          <UBadge v-if="counts.reorder" color="neutral" variant="subtle" size="sm">
            {{ t('ai.review.willReorder') }}
          </UBadge>
        </div>
      </div>
    </template>

    <div class="flex flex-col gap-4">
      <UTabs
        v-if="variantTabs.length > 1"
        v-model="activeVariant"
        :items="variantTabs"
        size="sm"
        :content="false"
      />

      <p v-if="proposal.operations.length === 0" class="text-sm text-muted">
        {{ t('ai.review.noChanges') }}
      </p>

      <!-- A child kept while its parent was rejected cannot be written. -->
      <UAlert
        v-if="dangling.length > 0"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :description="t('ai.review.dangling', { count: dangling.length })"
      />

      <div v-for="op in visible" :key="op.id" class="border-b border-default pb-3 last:border-b-0 last:pb-0">
        <div class="flex items-center gap-2">
          <UCheckbox v-model="accepted[op.id]" />
          <label class="text-sm font-medium">{{ labelFor(op) }}</label>

          <UBadge v-if="op.op === 'create'" color="success" variant="subtle" size="sm">
            {{ t('ai.review.willCreate') }}
          </UBadge>
          <UBadge v-else-if="op.op === 'delete'" color="error" variant="subtle" size="sm">
            {{ t('ai.review.willDelete') }}
          </UBadge>
          <span v-else-if="op.op === 'update' && op.current === null" class="text-xs text-dimmed">
            {{ t('ai.review.currentEmpty') }}
          </span>
        </div>

        <!-- What applying would overwrite. Captured server-side when the
             proposal was built, so this is a fact about the run rather than a
             best-effort read from the browser. -->
        <p
          v-if="op.op === 'update' && preview(op.current, op)"
          class="mt-1 line-clamp-2 text-xs text-muted"
        >
          <span class="text-dimmed">{{ t('ai.review.currentValue') }}:</span>
          {{ preview(op.current, op) }}
        </p>

        <!-- Where the value came from, when that is not the value it replaces
             — a translation's source, a normalization's raw input. -->
        <p v-if="op.derivedFrom?.preview" class="mt-1 line-clamp-2 text-xs text-muted">
          <span class="text-dimmed">
            {{ t('ai.review.derivedFrom') }}<template v-if="op.derivedFrom.label"> ({{ op.derivedFrom.label }})</template>:
          </span>
          {{ op.derivedFrom.preview }}
        </p>

        <p v-if="op.op === 'create' && op.existing" class="mt-1 text-xs text-muted">
          {{ t('ai.review.linksExisting', { id: op.existing.label ?? op.existing.id }) }}
        </p>

        <!-- update / create: an editable value -->
        <template v-if="op.op === 'update' || op.op === 'create'">
          <UInput
            v-if="controlOf(op) === 'text'"
            :model-value="textValue(op.id)"
            class="mt-1 w-full"
            :maxlength="op.display?.maxLength"
            :disabled="!accepted[op.id]"
            @update:model-value="(v: string) => setTextValue(op.id, v)"
          />

          <UTextarea
            v-else-if="controlOf(op) === 'multiline'"
            :model-value="textValue(op.id)"
            :rows="3"
            autoresize
            class="mt-1 w-full"
            :maxlength="op.display?.maxLength"
            :disabled="!accepted[op.id]"
            @update:model-value="(v: string) => setTextValue(op.id, v)"
          />

          <!-- Rich text stays the host's: it owns the editor its fields already
               use, and this kit takes no editor dependency to render a review. -->
          <div
            v-else-if="controlOf(op) === 'richtext'"
            class="mt-1"
            :class="!accepted[op.id] ? 'pointer-events-none opacity-50' : ''"
          >
            <slot
              name="richtext"
              :operation="op"
              :value="edited[op.id]"
              :set-value="(v: JsonValue) => { edited[op.id] = v }"
            />
          </div>

          <!-- Structured values the host has no control for. Readable rather
               than editable: showing JSON beats hiding the operation. -->
          <pre
            v-else
            class="mt-1 overflow-x-auto rounded bg-elevated p-2 text-xs"
          >{{ JSON.stringify(edited[op.id] ?? valueOf(op), null, 2) }}</pre>
        </template>

        <!-- delete: what is about to be lost -->
        <p v-else-if="op.op === 'delete'" class="mt-1 line-clamp-2 text-xs text-muted line-through">
          {{ preview(op.current, op) ?? t('ai.review.currentEmpty') }}
        </p>

        <!-- reorder: the sequence, before and after -->
        <div v-else-if="op.op === 'reorder'" class="mt-1 flex flex-col gap-1 text-xs">
          <div class="text-muted">
            <span class="text-dimmed">{{ t('ai.review.currentValue') }}:</span>
            {{ op.current.join(' → ') || '—' }}
          </div>
          <div>{{ op.proposed.join(' → ') }}</div>
        </div>

        <p v-if="op.display?.hint" class="mt-1 text-xs text-muted">
          {{ t('ai.review.charsRecommended', op.display.hint) }} ({{ textValue(op.id).length }})
        </p>
      </div>

      <!-- What the run considered and did not propose. Present because a
           review that shows only successes overstates what happened. -->
      <details v-if="proposal.skipped?.length" class="text-xs">
        <summary class="cursor-pointer text-muted">
          {{ t('ai.review.skipped', { count: proposal.skipped.length }) }}
        </summary>
        <ul class="mt-2 flex flex-col gap-1">
          <li v-for="(item, i) in proposal.skipped" :key="i" class="text-dimmed">
            <span v-if="item.path">{{ formatPath(item.path) }} — </span>{{ item.reason }}
            <span v-if="item.detail"> ({{ item.detail }})</span>
          </li>
        </ul>
      </details>

      <!-- Provenance: what produced these values, and what it cost. Present
           because a review that cannot say where a suggestion came from is not
           an oversight record. -->
      <dl
        v-if="proposal.provenance"
        class="flex flex-wrap gap-x-4 gap-y-1 border-t border-default pt-3 text-xs text-dimmed tabular-nums"
      >
        <div v-if="proposal.provenance.model" class="flex gap-1">
          <dt>model</dt>
          <dd class="text-muted">{{ proposal.provenance.model }}</dd>
        </div>
        <div v-if="proposal.provenance.keySource" class="flex gap-1">
          <dt>key</dt>
          <dd class="text-muted">{{ proposal.provenance.keySource }}</dd>
        </div>
        <div v-if="costLabel" class="flex gap-1">
          <dt>cost</dt>
          <dd class="text-muted">{{ costLabel }}</dd>
        </div>
      </dl>
    </div>

    <template #footer>
      <div class="flex items-center justify-end gap-2">
        <span class="mr-auto text-xs text-muted tabular-nums">
          {{ acceptedIds.length }} / {{ proposal.operations.length }}
        </span>
        <UButton
          :label="t('ai.review.dismiss')"
          variant="ghost"
          color="neutral"
          @click="emit('dismiss')"
        />
        <UButton
          :label="t('ai.review.apply')"
          color="primary"
          :loading="applying"
          :disabled="acceptedIds.length === 0"
          @click="submit"
        />
      </div>
    </template>
  </UCard>
</template>
