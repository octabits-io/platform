<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import * as z from 'zod'
import { useConfirm, useDirtyTracking } from '@octabits-io/nuxt-ui-kit'
import type { Period } from '@octabits-io/nuxt-ui-kit/dates'
import { useApi } from '~/composables/useApi'
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

interface Note {
  id: string
  title: string
  body: string
  createdAt: string
  updatedAt: string
}

const notes = ref<Note[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const { data, error } = await api.notes.get({ query: { page: 1, pageSize: 100 } })
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

const editorState = reactive({ title: '', body: '' })
const saving = ref(false)
const creatingNew = ref(false)

const { isDirty, resetInitial } = useDirtyTracking(editorState)

const noteSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(10_000),
})

// Loading a note into the form re-snapshots it, so a freshly-opened note is
// clean and the Save button stays disabled until something actually changes.
watch(selectedNote, (note) => {
  if (!note) return
  creatingNew.value = false
  resetInitial({ title: note.title, body: note.body })
}, { immediate: true })

function startNew() {
  creatingNew.value = true
  clearSelection()
  resetInitial({ title: '', body: '' })
}

async function save() {
  saving.value = true
  try {
    if (creatingNew.value) {
      const { error } = await api.notes.post({ ...editorState })
      if (error) { toastError(error); return }
      toast.add({ title: t('notes.create.success'), color: 'success' })
      creatingNew.value = false
    } else if (selectedId.value) {
      const { error } = await api.notes({ id: selectedId.value }).put({ ...editorState })
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

  const { error } = await api.notes({ id: note.id }).delete()
  if (error) { toastError(error); return }
  toast.add({ title: t('notes.delete.success'), color: 'success' })
  clearSelection()
  await load()
}
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

              <AppDateInput
                v-if="filterMode === 'on'"
                v-model="filterDay"
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
                    <p class="truncate text-sm font-medium">{{ note.title }}</p>
                    <p class="truncate text-xs text-muted">{{ formatDateTime(note.createdAt) }}</p>
                  </button>
                </li>
              </ul>
            </div>
          </div>
        </template>

        <div class="p-4">
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
              <UTextarea v-model="editorState.body" :rows="12" class="w-full" />
            </UFormField>

            <div class="flex items-center justify-between gap-2">
              <UButton
                v-if="selectedNote"
                :label="t('common.delete')"
                icon="i-lucide-trash-2"
                color="error"
                variant="ghost"
                @click="remove(selectedNote)"
              />
              <span v-else />
              <UButton
                type="submit"
                :label="creatingNew ? t('common.create') : t('common.save')"
                :loading="saving"
                :disabled="!isDirty"
              />
            </div>
          </UForm>
        </div>
      </AppSubSidebar>
    </template>
  </UDashboardPanel>
</template>
