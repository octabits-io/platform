<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, provide, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import * as z from 'zod'
import {
  HELP_PANEL_KEY,
  useConfirm,
  useDirtyTracking,
  useHelpPanel,
  type PageActionsItem,
} from '@octabits-io/nuxt-ui-kit'
import type { Period } from '@octabits-io/nuxt-ui-kit/dates'
import { pruneLocaleMap, type TranslationStatus } from '@octabits-io/nuxt-ui-kit/locale'
import NotesHelp from '~/components/NotesHelp.vue'
import { CONTENT_LOCALES, TRANSLATABLE_LOCALES } from '~/lib/contentLocales'
import { useApi } from '~/composables/useApi'
import { call } from '~/composables/useApiCall'
import { useApiError } from '~/composables/useApiError'
import { useDateFormat } from '~/composables/useDateFormat'

const { t } = useI18n()
const { api } = useApi()
const { toastError } = useApiError()
const { formatDateTime } = useDateFormat()
const { confirm } = useConfirm()
const toast = useToast()
const route = useRoute()
const router = useRouter()

/**
 * The edit/wire shape of the kit's `LocaleMap<string>`: **sparse** — a locale
 * with no value has no key, so every read is `string | undefined`. Spelling it
 * out here rather than importing the framework type keeps this app's only
 * dependency on the server contract the `hc` client types.
 */
type LocaleText = Record<string, string | undefined>

interface Note {
  id: string
  title: string
  body: string
  publicTitle: LocaleText
  publicBody: LocaleText
  createdAt: string
  updatedAt: string
}

const notes = ref<Note[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const { data, error } = await call(api.notes.$get({ query: { page: '1', pageSize: '100' } }))
    if (error) { toastError(error); return }
    notes.value = data.items
  } finally {
    loading.value = false
  }
}

await load()

// --- Creation-date filter -------------------------------------------------
//
// Client-side on purpose: the notes API has no date filter, and the whole list
// is already in memory. It is a genuine home for the kit's three date surfaces:
// DateInput for a single day, DateRangeInput for a span, PeriodDisplay to echo
// the active span back.

type FilterMode = 'all' | 'on' | 'between'

const filterMode = ref<FilterMode>('all')
const filterDay = ref('')
/**
 * A `ref`, not a `reactive`. `DateRangeInput` emits a *new* `Period` object
 * (`emit('update:modelValue', { start, end })`), and `v-model` assigns it to
 * the binding rather than mutating it — which a `reactive` object cannot
 * absorb. With `reactive` the SFC compiler silently rewrites the `const` to a
 * `let` to make the assignment legal ("v-model cannot update a const reactive
 * binding"), but the reassigned plain object is not what `periodIsComplete`
 * tracks, so the computed never re-evaluates: both dates get picked, the range
 * filter never engages, and `PeriodDisplay` never renders. A `ref` is the
 * assignable box `v-model` actually wants.
 */
const filterPeriod = ref<Period>({ start: '', end: '' })

const filterModeItems = computed(() => [
  { label: t('notes.filter.modeAll'), value: 'all' as const },
  { label: t('notes.filter.modeOn'), value: 'on' as const },
  { label: t('notes.filter.modeBetween'), value: 'between' as const },
])

/** `createdAt` is an ISO datetime; the filters compare calendar days. */
function dayOf(iso: string): string {
  return iso.slice(0, 10)
}

const periodIsComplete = computed(() => !!filterPeriod.value.start && !!filterPeriod.value.end)

const filteredNotes = computed(() => {
  if (filterMode.value === 'on' && filterDay.value) {
    return notes.value.filter(n => dayOf(n.createdAt) === filterDay.value)
  }
  if (filterMode.value === 'between' && periodIsComplete.value) {
    // ISO YYYY-MM-DD strings sort chronologically, so plain comparison works.
    return notes.value.filter((n) => {
      const day = dayOf(n.createdAt)
      return day >= filterPeriod.value.start && day <= filterPeriod.value.end
    })
  }
  return notes.value
})

// --- Translation completeness ---------------------------------------------

/**
 * The `TranslationStatus` behind `TranslationBadge`. The kit ships the badge
 * and the type, not the counting — what counts as a translatable leaf is the
 * app's schema, and here it is the two public fields.
 *
 * `undefined` (not "complete") when the note has no public text at all: a note
 * nobody has written a customer-facing version of has nothing to translate,
 * and a green check on it would claim otherwise. `de-formal` is not counted —
 * see `TRANSLATABLE_LOCALES`.
 */
function statusOf(note: Note): TranslationStatus | undefined {
  const fields = [note.publicTitle, note.publicBody].filter(
    field => Object.values(field ?? {}).some(value => (value ?? '').trim().length > 0),
  )
  if (!fields.length) return undefined

  const missing: Record<string, number> = {}
  for (const locale of TRANSLATABLE_LOCALES) {
    const gaps = fields.filter(field => !field[locale]?.trim()).length
    if (gaps > 0) missing[locale] = gaps
  }
  return { complete: Object.keys(missing).length === 0, missing }
}

// --- Selection (drives SubSidebar's mobile auto-close via `?s=`) -----------

const selectedId = computed(() => {
  const s = route.query.s
  return typeof s === 'string' ? s : null
})

const selectedNote = computed(() => notes.value.find(n => n.id === selectedId.value) ?? null)

function select(id: string) {
  void router.push({ query: { ...route.query, s: id } })
}

function clearSelection() {
  const { s: _s, ...rest } = route.query
  void router.push({ query: rest })
}

// --- Editor ---------------------------------------------------------------

const editorState = reactive<{
  title: string
  body: string
  publicTitle: LocaleText
  publicBody: LocaleText
}>({ title: '', body: '', publicTitle: {}, publicBody: {} })

const saving = ref(false)
const creatingNew = ref(false)

const { isDirty, resetInitial } = useDirtyTracking(editorState)

/**
 * Sparse on purpose — `.optional()` on the value, matching what the editors
 * hold: clearing a register-variant tab DELETES its key so the value falls
 * through to its base locale, and a form schema that demanded a string per
 * declared locale would flag exactly that intent as invalid.
 * `pruneLocaleMap` densifies it again at the API boundary.
 */
const localeMapSchema = z.record(z.string(), z.string().optional())

const noteSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(10_000),
  publicTitle: localeMapSchema,
  publicBody: localeMapSchema,
})

/** The editor's view of a note — copied, never the list row itself. */
function editorValues(note: Note | null) {
  return {
    title: note?.title ?? '',
    body: note?.body ?? '',
    // Copied: the locale editors assign whole maps, but the snapshot the dirty
    // tracker keeps would otherwise share this object with the list row.
    publicTitle: { ...(note?.publicTitle ?? {}) },
    publicBody: { ...(note?.publicBody ?? {}) },
  }
}

// Loading a note into the form re-snapshots it, so a freshly-opened note is
// clean and the Save button stays disabled until something actually changes.
watch(selectedNote, (note) => {
  if (!note) return
  creatingNew.value = false
  resetInitial(editorValues(note))
}, { immediate: true })

function startNew() {
  creatingNew.value = true
  clearSelection()
  resetInitial(editorValues(null))
}

/** Throw the edits away and go back to what the server last returned. */
function discard() {
  resetInitial(editorValues(creatingNew.value ? null : selectedNote.value))
}

/**
 * The wire payload. `pruneLocaleMap` drops empty leaves — a cleared tab must
 * not be stored as `''`, which would shadow the fallback rather than fall
 * through to it — and hands back a dense `Record<string, string>`, which is
 * exactly the shape the route's `z.record(z.string(), z.string())` accepts.
 */
function notePayload() {
  return {
    title: editorState.title,
    body: editorState.body,
    publicTitle: pruneLocaleMap(editorState.publicTitle),
    publicBody: pruneLocaleMap(editorState.publicBody),
  }
}

async function save() {
  saving.value = true
  try {
    if (creatingNew.value) {
      const { error } = await call(api.notes.$post({ json: notePayload() }))
      if (error) { toastError(error); return }
      toast.add({ title: t('notes.create.success'), color: 'success' })
      creatingNew.value = false
    } else if (selectedId.value) {
      const { error } = await call(api.notes[':id'].$put({ param: { id: selectedId.value }, json: notePayload() }))
      if (error) { toastError(error); return }
      toast.add({ title: t('notes.edit.success'), color: 'success' })
    } else {
      return
    }
    resetInitial()
    await load()
  } finally {
    saving.value = false
  }
}

async function remove(note: Note) {
  const ok = await confirm({
    title: t('notes.delete.title'),
    message: t('notes.delete.message', { title: note.title }),
    dangerous: true,
  })
  if (!ok) return

  const { error } = await call(api.notes[':id'].$delete({ param: { id: note.id } }))
  if (error) { toastError(error); return }
  toast.add({ title: t('notes.delete.success'), color: 'success' })
  clearSelection()
  await load()
}

// --- Detail-pane chrome ---------------------------------------------------

/**
 * One declarative list drives the whole detail header: which buttons render
 * inline, which fold into ⋯, and what happens to them as the pane narrows.
 *
 * Three conventions the kit enforces and this list relies on:
 *  - exactly one `tone: 'primary'` per state (Save),
 *  - destructive actions live in the menu (`visibility: 'menu'` + `color:
 *    'error'`), never inline,
 *  - `disabledReason` rather than a bare `disabled` wherever the block has a
 *    reason worth reading — the button renders disabled and its tooltip says
 *    why, and clicking it does nothing at all (a disabled button under a
 *    tooltip wrapper used to leak its click to the parent).
 */
const editorActions = computed<PageActionsItem[]>(() => [
  {
    key: 'save',
    icon: 'i-lucide-save',
    label: creatingNew.value ? t('common.create') : t('common.save'),
    tone: 'primary',
    visibility: 'always',
    loading: saving.value,
    disabledReason: isDirty.value ? null : t('notes.actions.nothingToSave'),
    onSelect: () => { void save() },
  },
  {
    key: 'discard',
    icon: 'i-lucide-undo-2',
    label: t('notes.actions.discard'),
    visibility: 'auto',
    disabledReason: isDirty.value ? null : t('notes.actions.nothingToDiscard'),
    onSelect: discard,
  },
  {
    key: 'delete',
    icon: 'i-lucide-trash-2',
    label: t('common.delete'),
    visibility: 'menu',
    color: 'error',
    // Convention: the destructive row sits in the last-declared section, so the
    // menu separates it from everything above it.
    section: 'danger',
    disabled: !selectedNote.value,
    onSelect: () => { if (selectedNote.value) void remove(selectedNote.value) },
  },
])

/** Page-level utilities: they change nothing, so they collapse first. */
const editorUtilities = computed<PageActionsItem[]>(() => [
  {
    key: 'new',
    icon: 'i-lucide-plus',
    label: t('notes.new'),
    onSelect: startNew,
  },
])

const headerTitle = computed(() =>
  creatingNew.value ? t('notes.newTitle') : (selectedNote.value?.title ?? ''),
)

/**
 * Short on purpose. `density="compact"` promises ONE row and keeps it by
 * truncating — but truncation is a degradation, not a layout: in a 600px
 * detail pane a subtitle carrying two timestamps eats the room the note's own
 * name needs, and both end up clipped. Put the rest in the help panel.
 */
const headerSubtitle = computed(() => {
  const note = selectedNote.value
  if (creatingNew.value || !note) return t('notes.newSubtitle')
  return t('notes.detailSubtitle', { updated: formatDateTime(note.updatedAt) })
})

// --- Help panel -----------------------------------------------------------

/**
 * The registry is provided by the page, so `PageActions` / `PageUtilityActions`
 * find it by injection and the Help trigger appears on its own. Registration is
 * owner-scoped in the kit: the disposer returned here removes *this* page's
 * registration and nothing else, which is what keeps a shared tab value safe
 * when one route replaces another.
 */
const help = useHelpPanel({ storageKey: 'demo-help-open' })
provide(HELP_PANEL_KEY, help)

const helpProps = reactive({
  shown: computed(() => filteredNotes.value.length),
  total: computed(() => notes.value.length),
  locales: CONTENT_LOCALES,
})

onBeforeUnmount(help.register('notes', [{
  key: 'filter',
  label: t('notes.help.title'),
  icon: 'i-lucide-circle-help',
  // `markRaw`: the registry stores the component itself, and Vue must not wrap
  // a component definition in a reactive proxy.
  component: markRaw(NotesHelp),
  props: helpProps,
}]))

// After registering, not before: `setActiveTab` closes the panel when the tab
// it switches to has no actions, so activating an empty tab would throw away
// the operator's persisted open state on every page load.
help.setActiveTab('notes')
</script>

<template>
  <UDashboardPanel id="notes">
    <template #header>
      <UDashboardNavbar :title="t('notes.title')">
        <template #right>
          <UButton :label="t('notes.new')" icon="i-lucide-plus" @click="startNew" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- The kit's list/detail shell: a desktop column + a mobile slideover
           that auto-closes when `?s=` changes. -->
      <AppSubSidebar
        :title="t('notes.list')"
        :loading="loading"
        width="w-[300px]"
        selection-query-key="s"
        class="-m-4 h-[calc(100%+2rem)] sm:-m-6 sm:h-[calc(100%+3rem)]"
      >
        <template #sidebar>
          <div class="flex min-h-0 flex-1 flex-col">
            <div class="flex flex-col gap-2 border-b border-default p-3">
              <p class="text-xs font-medium uppercase tracking-wide text-muted">
                {{ t('notes.filter.title') }}
              </p>

              <USelect
                v-model="filterMode"
                :items="filterModeItems"
                value-key="value"
                size="sm"
                :aria-label="t('notes.filter.mode')"
              />

              <!-- `size` matches the rail's other controls; `clearable` is what
                   gives an optional filter a way back to "no date" — a calendar
                   can only ever pick. -->
              <AppDateInput
                v-if="filterMode === 'on'"
                v-model="filterDay"
                size="sm"
                clearable
                :placeholder="t('notes.filter.on')"
              />

              <template v-if="filterMode === 'between'">
                <AppDateRangeInput v-model="filterPeriod" size="sm" />
                <AppPeriodDisplay
                  v-if="periodIsComplete"
                  :period="filterPeriod"
                  kind="booking"
                  size="xs"
                />
              </template>

              <p v-if="filterMode !== 'all'" class="text-xs text-muted">
                {{ t('notes.filter.showing', { shown: filteredNotes.length, total: notes.length }) }}
              </p>
            </div>

            <div class="min-h-0 flex-1 overflow-y-auto p-2">
              <p v-if="!filteredNotes.length" class="p-3 text-sm text-muted">
                {{ t('notes.empty') }}
              </p>
              <ul v-else class="flex flex-col gap-1">
                <li v-for="note in filteredNotes" :key="note.id">
                  <button
                    type="button"
                    class="w-full rounded-md px-3 py-2 text-left transition-colors hover:bg-elevated"
                    :class="note.id === selectedId ? 'bg-elevated' : ''"
                    @click="select(note.id)"
                  >
                    <span class="flex items-center gap-1.5">
                      <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ note.title }}</span>
                      <!-- Hides itself for a note with no public text at all. -->
                      <AppTranslationBadge :status="statusOf(note)" />
                    </span>
                    <span class="block truncate text-xs text-muted">{{ formatDateTime(note.createdAt) }}</span>
                  </button>
                </li>
              </ul>
            </div>
          </div>
        </template>

        <div class="flex h-full min-w-0">
          <div class="flex min-w-0 flex-1 flex-col">
            <!-- The compact band: one row, actions right, Help last.
                 `:help="false"` on PageActions hands the Help trigger back to
                 PageHeader's own `#utility` cluster (PageUtilityActions) — the
                 other of the two ways the kit renders it. -->
            <AppPageHeader
              v-if="selectedNote || creatingNew"
              density="compact"
              :title="headerTitle"
              :subtitle="headerSubtitle"
              back
            >
              <template #badges>
                <AppTranslationBadge v-if="selectedNote" :status="statusOf(selectedNote)" />
              </template>
              <template #actions>
                <AppPageActions
                  :items="editorActions"
                  :utility-items="editorUtilities"
                  :help="false"
                  :collapse-below="760"
                  :utility-collapse-below="900"
                />
              </template>
            </AppPageHeader>

            <div class="min-h-0 flex-1 overflow-y-auto p-4">
              <div v-if="!selectedNote && !creatingNew" class="py-12 text-center text-sm text-muted">
                {{ t('notes.selectPrompt') }}
              </div>

              <UForm
                v-else
                :schema="noteSchema"
                :state="editorState"
                class="flex flex-col gap-4"
                @submit="save"
              >
                <UFormField :label="t('notes.fields.title')" name="title" required>
                  <UInput v-model="editorState.title" class="w-full" />
                </UFormField>

                <UFormField :label="t('notes.fields.body')" name="body">
                  <UTextarea v-model="editorState.body" :rows="8" class="w-full" />
                </UFormField>

                <USeparator :label="t('notes.publicSection')" />

                <!-- Per-locale fields. The tab strip, the completeness dots and
                     the value plumbing are the kit's; the locale SET is the
                     app's (`~/lib/contentLocales.ts`, provided in `app.vue`). -->
                <AppLocaleInput
                  v-model="editorState.publicTitle"
                  :label="t('notes.fields.publicTitle')"
                  :description="t('notes.fields.publicTitleHint')"
                  name="publicTitle"
                  :maxlength="200"
                />

                <!-- `register-override` surfaces `de-formal` as an optional
                     override tab: leave it blank and it inherits `de` (neutral
                     dot), which is why a variant is never counted as missing. -->
                <AppLocaleTextarea
                  v-model="editorState.publicBody"
                  :label="t('notes.fields.publicBody')"
                  :description="t('notes.fields.publicBodyHint')"
                  name="publicBody"
                  :rows="6"
                  register-override
                />
              </UForm>
            </div>
          </div>

          <AppHelpPanel />
        </div>
      </AppSubSidebar>
    </template>
  </UDashboardPanel>
</template>
