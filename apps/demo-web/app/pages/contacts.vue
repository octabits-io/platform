<script setup lang="ts">
import { computed, h, markRaw, onBeforeUnmount, provide, reactive, ref, resolveComponent } from 'vue'
import { useI18n } from 'vue-i18n'
import * as z from 'zod'
import type { TableColumn, TableRow } from '@nuxt/ui'
import {
  HELP_PANEL_KEY,
  useConfirm,
  useDirtyTracking,
  useHelpPanel,
  usePagination,
  type PageActionsItem,
} from '@octabits-io/nuxt-ui-kit'
import type { Period } from '@octabits-io/nuxt-ui-kit/dates'
import ContactsHelp from '~/components/ContactsHelp.vue'
import { useApi } from '~/composables/useApi'
import { call } from '~/composables/useApiCall'
import { useApiError } from '~/composables/useApiError'
import { useDateFormat } from '~/composables/useDateFormat'
import { useAiProgressStore } from '~/stores/aiProgress'
import { aiWorkflowRegistry, CONTACT_BRIEF } from '~/lib/aiWorkflows'

const { t } = useI18n()
const { api } = useApi()
const { toastError } = useApiError()
const { formatDateTime, formatDateMedium } = useDateFormat()
const { confirm } = useConfirm()
const toast = useToast()

const UButton = resolveComponent('UButton')
const UDropdownMenu = resolveComponent('UDropdownMenu')

interface Contact {
  id: string
  name: string
  email: string
  /** The travel wish, in the kit's `Period` vocabulary (`''` = unset). */
  wishStart: string
  wishEnd: string
  wishNights: number | null
  createdAt: string
  updatedAt: string
}

const rows = ref<Contact[]>([])
const loading = ref(false)
const searchTerm = ref('')
const searchActive = ref(false)

/**
 * The kit's offset-pagination primitive. Note the impedance mismatch worth
 * knowing about: `usePagination` also exposes a ready-to-spread
 * `queryParams { limit, offset }`, but this API paginates by `page`/`pageSize`,
 * so the `page`/`itemsPerPage` refs are what get used and `queryParams` is
 * ignored. `onPaginationChange` is the refetch hook — and it takes the async
 * loader directly: the hook is fire-and-forget by design, so the kit types it
 * `() => void | Promise<void>` rather than making every call site wrap a
 * promise it is not supposed to await.
 */
const { page, itemsPerPage, total, setTotal, resetPagination } = usePagination({
  defaultLimit: 10,
  onPaginationChange: load,
})

async function load() {
  // A blind-index lookup is exact-match and returns at most one row, so it
  // replaces the paginated list rather than filtering it.
  if (searchActive.value) return
  loading.value = true
  try {
    const { data, error } = await call(api.contacts.$get({
      // `hc` serialises query values verbatim, so numbers go over as strings —
      // the route's `z.coerce.number()` is what turns them back.
      query: { page: String(page.value), pageSize: String(itemsPerPage.value) },
    }))
    if (error) { toastError(error); return }
    rows.value = data.items
    setTotal(data.total)
  } finally {
    loading.value = false
  }
}

async function runSearch() {
  const email = searchTerm.value.trim()
  if (!email) { await clearSearch(); return }
  loading.value = true
  try {
    const { data, error } = await call(api.contacts.search.$get({ query: { email } }))
    if (error) { toastError(error); return }
    searchActive.value = true
    rows.value = data.items
    setTotal(data.items.length)
    toast.add({ title: t('contacts.search.resultCount', data.items.length) })
  } finally {
    loading.value = false
  }
}

async function clearSearch() {
  searchTerm.value = ''
  searchActive.value = false
  resetPagination()
  await load()
}

await load()

// --- Selection ------------------------------------------------------------
//
// The header acts on ONE contact, so the table needs a selected row. Kept as
// an id rather than the row object: a reload replaces every object, and a
// stale reference would keep a deleted contact "selected".

const selectedId = ref<string | null>(null)

const selectedContact = computed(() => rows.value.find(c => c.id === selectedId.value) ?? null)

function onRowSelect(_event: Event, row: TableRow<Contact>) {
  selectedId.value = selectedId.value === row.original.id ? null : row.original.id
}

// --- Create ---------------------------------------------------------------

const createOpen = ref(false)
const createState = reactive({
  name: '',
  email: '',
  wish: { start: '', end: '' } as Period,
  wishNights: null as number | null,
})
const creating = ref(false)

// Zod messages are locale-synced by plugins/02.zod-locale.ts. The wish is not
// in the schema: `FlexiblePeriodInput` validates it internally (nights against
// the window) and UForm ignores state keys the schema does not mention.
const contactSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.email(),
})

function openCreate() {
  createState.name = ''
  createState.email = ''
  createState.wish = { start: '', end: '' }
  createState.wishNights = null
  createOpen.value = true
}

async function submitCreate() {
  creating.value = true
  try {
    const { error } = await call(api.contacts.$post({
      json: {
        name: createState.name,
        email: createState.email,
        ...wishPayload(createState.wish, createState.wishNights),
      },
    }))
    if (error) { toastError(error); return }
    toast.add({ title: t('contacts.create.success'), color: 'success' })
    createOpen.value = false
    await clearSearch()
  } finally {
    creating.value = false
  }
}

/** `''` clears the column server-side, so a half-filled window round-trips as typed. */
function wishPayload(wish: Period, nights: number | null) {
  return { wishStart: wish.start, wishEnd: wish.end, wishNights: nights }
}

// --- Edit (dirty-tracked) -------------------------------------------------

const editOpen = ref(false)
const editing = ref(false)
const editId = ref<string | null>(null)
const editState = reactive({
  name: '',
  email: '',
  wish: { start: '', end: '' } as Period,
  wishNights: null as number | null,
})

/**
 * `useDirtyTracking` snapshots the reactive state and deep-compares against it.
 * `resetInitial(values)` re-snapshots *after* assigning, which is exactly the
 * "load a record into the form" move — so opening the modal on a new contact
 * starts clean rather than instantly dirty. The wish rides along: a deep
 * compare covers the nested `Period` without any extra wiring.
 */
const { isDirty, resetInitial } = useDirtyTracking(editState)

function openEdit(contact: Contact) {
  editId.value = contact.id
  resetInitial({
    name: contact.name,
    email: contact.email,
    wish: { start: contact.wishStart, end: contact.wishEnd },
    wishNights: contact.wishNights,
  })
  editOpen.value = true
}

async function submitEdit() {
  if (!editId.value) return
  editing.value = true
  try {
    const { error } = await call(api.contacts[':id'].$put({
      param: { id: editId.value },
      json: {
        name: editState.name,
        email: editState.email,
        ...wishPayload(editState.wish, editState.wishNights),
      },
    }))
    if (error) { toastError(error); return }
    toast.add({ title: t('contacts.edit.success'), color: 'success' })
    resetInitial()
    editOpen.value = false
    await load()
  } finally {
    editing.value = false
  }
}

// --- AI contact brief -------------------------------------------------------

/**
 * The cross-page progress store — the navbar badge reads `hasActive`, which
 * keeps signalling after the modal closes. (`appliedSignal` is the store's
 * reload hook; applying a brief creates a note, so notes.vue would be the page
 * to watch it — nothing to reload here.)
 */
const aiProgress = useAiProgressStore()

const aiOpen = ref(false)
const aiContact = ref<Contact | null>(null)

function openAiBrief(contact: Contact) {
  aiContact.value = contact
  aiOpen.value = true
}

// --- Row actions ----------------------------------------------------------

async function sendWelcome(contact: Contact) {
  const { data, error } = await call(api.contacts[':id'].welcome.$post({ param: { id: contact.id } }))
  if (error) { toastError(error); return }
  toast.add({
    title: t('contacts.welcome.success', { id: data.jobId }),
    description: data.replayed ? t('contacts.welcome.replayed') : undefined,
    color: data.replayed ? 'warning' : 'success',
  })
}

async function removeContact(contact: Contact) {
  // The kit's promise-based confirm — the dialog itself is mounted once in the
  // default layout, and this call awaits that singleton.
  const ok = await confirm({
    title: t('contacts.delete.title'),
    message: t('contacts.delete.message', { name: contact.name }),
    dangerous: true,
  })
  if (!ok) return

  const { error } = await call(api.contacts[':id'].$delete({ param: { id: contact.id } }))
  // With the viewer role this is the server's 403 (`forbidden`), which the kit's
  // messenger maps to `errors.forbidden` from the locale file.
  if (error) { toastError(error); return }
  toast.add({ title: t('contacts.delete.success'), color: 'success' })
  if (selectedId.value === contact.id) selectedId.value = null
  await load()
}

// --- Page header ----------------------------------------------------------

/** The blocker every header action shares: nothing is selected. */
const noSelection = computed(() => (selectedContact.value ? null : t('contacts.actions.selectFirst')))

/**
 * The header's whole action set, declared once.
 *
 * `kind: 'ai'` is not decoration: it moves the item into the AI cluster, which
 * renders as the kit's `AiButton` (sparkles + soft primary) and — when
 * collapsed — as a menu group that always sits ABOVE the destructive section,
 * whatever order this array happens to be in.
 */
const headerActions = computed<PageActionsItem[]>(() => [
  {
    key: 'new',
    icon: 'i-lucide-plus',
    label: t('contacts.new'),
    tone: 'primary',
    visibility: 'always',
    onSelect: openCreate,
  },
  {
    key: 'edit',
    icon: 'i-lucide-pencil',
    label: t('common.edit'),
    visibility: 'auto',
    disabledReason: noSelection.value,
    onSelect: () => { if (selectedContact.value) openEdit(selectedContact.value) },
  },
  {
    key: 'welcome',
    icon: 'i-lucide-mail',
    label: t('contacts.welcome.action'),
    visibility: 'auto',
    disabledReason: noSelection.value,
    onSelect: () => { if (selectedContact.value) void sendWelcome(selectedContact.value) },
  },
  {
    key: 'brief',
    kind: 'ai',
    icon: 'i-lucide-sparkles',
    label: t('ai.brief.action'),
    description: t('ai.brief.description'),
    disabledReason: noSelection.value,
    onSelect: () => { if (selectedContact.value) openAiBrief(selectedContact.value) },
  },
  {
    key: 'delete',
    icon: 'i-lucide-trash-2',
    label: t('common.delete'),
    visibility: 'menu',
    color: 'error',
    section: 'danger',
    disabledReason: noSelection.value,
    onSelect: () => { if (selectedContact.value) void removeContact(selectedContact.value) },
  },
])

/** Utilities change nothing, which is why they are the first thing dropped. */
const headerUtilities = computed<PageActionsItem[]>(() => [
  {
    key: 'refresh',
    icon: 'i-lucide-refresh-cw',
    label: t('common.refresh'),
    loading: loading.value,
    onSelect: () => { void load() },
  },
])

const headerSubtitle = computed(() =>
  selectedContact.value
    ? t('contacts.selectedSubtitle', { name: selectedContact.value.name })
    : t('contacts.description'),
)

// --- Help panel -----------------------------------------------------------

const help = useHelpPanel({ storageKey: 'demo-help-open' })
provide(HELP_PANEL_KEY, help)

const helpProps = reactive({
  selected: computed(() => selectedContact.value?.name ?? null),
})

onBeforeUnmount(help.register('contacts', [{
  key: 'overview',
  label: t('contacts.help.title'),
  icon: 'i-lucide-circle-help',
  component: markRaw(ContactsHelp),
  props: helpProps,
}]))

// After registering, not before: `setActiveTab` closes the panel when the tab
// it switches to has no actions, so activating an empty tab would throw away
// the operator's persisted open state on every page load.
help.setActiveTab('contacts')

// --- Table ----------------------------------------------------------------

/** "Jun 1 – Jun 21 · 7 nights", or nothing when the contact has no wish. */
function formatWish(contact: Contact): string {
  if (!contact.wishStart && !contact.wishEnd && contact.wishNights == null) return ''
  const window = [contact.wishStart, contact.wishEnd]
    .map(iso => (iso ? formatDateMedium(iso) : '…'))
    .join(' – ')
  return contact.wishNights == null
    ? window
    : `${window} · ${t('period.travel.nights', contact.wishNights)}`
}

const columns = computed<TableColumn<Contact>[]>(() => [
  {
    accessorKey: 'name',
    header: t('contacts.columns.name'),
    // The selected row is what the header acts on, so it has to be visible.
    cell: ({ row }) => h('span', {
      class: row.original.id === selectedId.value ? 'font-semibold text-primary' : '',
    }, row.original.name),
  },
  { accessorKey: 'email', header: t('contacts.columns.email') },
  {
    id: 'wish',
    header: t('contacts.columns.wish'),
    cell: ({ row }) => formatWish(row.original) || '—',
  },
  {
    accessorKey: 'createdAt',
    header: t('contacts.columns.createdAt'),
    cell: ({ row }) => formatDateTime(row.original.createdAt),
  },
  {
    id: 'actions',
    header: '',
    cell: ({ row }) =>
      h('div', { class: 'flex justify-end' }, [
        h(UDropdownMenu, {
          items: [
            {
              label: t('contacts.welcome.action'),
              icon: 'i-lucide-mail',
              onSelect: () => { void sendWelcome(row.original) },
            },
            {
              label: t('ai.brief.action'),
              icon: 'i-lucide-sparkles',
              onSelect: () => openAiBrief(row.original),
            },
            {
              label: t('common.edit'),
              icon: 'i-lucide-pencil',
              onSelect: () => openEdit(row.original),
            },
            {
              label: t('common.delete'),
              icon: 'i-lucide-trash-2',
              color: 'error' as const,
              onSelect: () => { void removeContact(row.original) },
            },
          ],
        }, () => h(UButton, {
          icon: 'i-lucide-ellipsis-vertical',
          color: 'neutral',
          variant: 'ghost',
          size: 'sm',
        })),
      ]),
  },
])
</script>

<template>
  <UDashboardPanel id="contacts">
    <template #header>
      <!-- The kit's PageHeader IS this page's header — not a band inside one.
           It measures its own width (ResizeObserver) and provides it to
           PageActions, which is what makes the collapse thresholds below real:
           narrow the window and watch the utilities go first, then the 'auto'
           actions, with Save-equivalents ('always') never leaving the bar. -->
      <AppPageHeader
        :title="t('contacts.title')"
        :subtitle="headerSubtitle"
        class="min-h-16 shrink-0 border-b border-default px-4 py-2 sm:px-6"
      >
        <template #title>
          <div class="flex min-w-0 items-center gap-2">
            <!-- Nuxt UI's sidebar trigger; the kit header has no opinion about
                 what leads the row. -->
            <UDashboardSidebarToggle />
            <h1 class="truncate font-display text-2xl font-semibold tracking-tight">
              {{ t('contacts.title') }}
            </h1>
          </div>
        </template>

        <template #badges>
          <!-- Fed by the ai-progress store — keeps signalling after the modal closes. -->
          <UBadge v-if="aiProgress.hasActive" color="primary" variant="subtle" icon="i-lucide-sparkles">
            {{ t('ai.activeBadge') }}
          </UBadge>
        </template>

        <template #actions>
          <!-- `:help="false"`: this header keeps Help in PageHeader's own
               `#utility` cluster (`PageUtilityActions`), the fixed one. It fits
               a full-width page header, where there is always room — the
               width-aware alternative is demoed on `/notes`. -->
          <AppPageActions
            :items="headerActions"
            :utility-items="headerUtilities"
            :help="false"
            :collapse-below="1100"
            :utility-collapse-below="1280"
          />
        </template>
      </AppPageHeader>
    </template>

    <template #body>
      <div class="flex h-full min-w-0">
        <div class="flex min-w-0 flex-1 flex-col gap-4">
          <div class="flex flex-wrap items-start gap-2">
            <UFormField :hint="t('contacts.search.hint')" class="grow max-w-md">
              <UInput
                v-model="searchTerm"
                icon="i-lucide-search"
                :placeholder="t('contacts.search.placeholder')"
                :aria-label="t('contacts.search.label')"
                class="w-full"
                @keydown.enter="runSearch"
              />
            </UFormField>
            <UButton :label="t('common.search')" color="neutral" variant="subtle" @click="runSearch" />
            <UButton
              v-if="searchActive"
              :label="t('contacts.search.clear')"
              color="neutral"
              variant="ghost"
              icon="i-lucide-x"
              @click="clearSearch"
            />
          </div>

          <!-- Row click selects; the header acts on the selection. -->
          <UTable
            :data="rows"
            :columns="columns"
            :loading="loading"
            class="shrink-0"
            @select="onRowSelect"
          >
            <template #empty>
              <p class="py-6 text-center text-sm text-muted">{{ t('contacts.empty') }}</p>
            </template>
          </UTable>

          <div v-if="!searchActive && total > itemsPerPage" class="flex justify-end">
            <UPagination
              v-model:page="page"
              :items-per-page="itemsPerPage"
              :total="total"
            />
          </div>
        </div>

        <AppHelpPanel />
      </div>

      <!--
        The modals live *inside* `#body`, not as direct children of
        `UDashboardPanel`. That is not cosmetic: the panel renders its named
        slots as the *fallback* of its default slot —

            <slot><slot name="header" /><slot name="body" />…</slot>

        — so any default-slot child replaces the whole header/body tree. A modal
        parked there teleports itself to `<body>` and leaves a blank panel
        behind: no error, no warning, and `nuxt typecheck` stays green. Both
        modals teleport regardless of where they are declared, so nesting them
        here costs nothing.
      -->

      <!-- Create -->
      <UModal v-model:open="createOpen" :title="t('contacts.create.title')">
        <template #body>
          <UForm :schema="contactSchema" :state="createState" class="flex flex-col gap-4" @submit="submitCreate">
            <UFormField :label="t('contacts.fields.name')" name="name" required>
              <UInput v-model="createState.name" class="w-full" />
            </UFormField>
            <UFormField :label="t('contacts.fields.email')" name="email" required>
              <UInput v-model="createState.email" type="email" class="w-full" />
            </UFormField>
            <!-- Window + stay length as ONE control: the window is when they
                 could travel, the nights are how long they want to stay inside
                 it. The component owns the cross-field rule (nights must fit
                 the window) and needs a definite width, never shrink-to-fit. -->
            <UFormField :label="t('contacts.fields.wish')" :hint="t('contacts.fields.wishHint')">
              <AppFlexiblePeriodInput
                v-model="createState.wish"
                :nights="createState.wishNights"
                size="sm"
                class="w-full"
                @update:nights="createState.wishNights = $event"
              />
            </UFormField>
            <div class="flex justify-end gap-2">
              <UButton
                :label="t('common.cancel')"
                color="neutral"
                variant="outline"
                @click="createOpen = false"
              />
              <UButton type="submit" :label="t('common.create')" :loading="creating" />
            </div>
          </UForm>
        </template>
      </UModal>

      <!-- AI contact brief. `:key` resets the workflow guard when the target
           contact changes; the registry supplies the human label. -->
      <UModal
        v-model:open="aiOpen"
        :title="`${aiWorkflowRegistry.getLabel(CONTACT_BRIEF.type, t)} — ${aiContact?.name ?? ''}`"
      >
        <template #body>
          <AiContactBrief v-if="aiContact" :key="aiContact.id" :contact="aiContact" />
        </template>
      </UModal>

      <!-- Edit -->
      <UModal v-model:open="editOpen" :title="t('contacts.edit.title')">
        <template #body>
          <UForm :schema="contactSchema" :state="editState" class="flex flex-col gap-4" @submit="submitEdit">
            <UFormField :label="t('contacts.fields.name')" name="name" required>
              <UInput v-model="editState.name" class="w-full" />
            </UFormField>
            <UFormField :label="t('contacts.fields.email')" name="email" required>
              <UInput v-model="editState.email" type="email" class="w-full" />
            </UFormField>
            <UFormField :label="t('contacts.fields.wish')" :hint="t('contacts.fields.wishHint')">
              <AppFlexiblePeriodInput
                v-model="editState.wish"
                :nights="editState.wishNights"
                size="sm"
                class="w-full"
                @update:nights="editState.wishNights = $event"
              />
            </UFormField>
            <div class="flex justify-end gap-2">
              <UButton
                :label="t('common.cancel')"
                color="neutral"
                variant="outline"
                @click="editOpen = false"
              />
              <!-- Nothing changed → nothing to save. -->
              <UButton
                type="submit"
                :label="t('common.save')"
                :loading="editing"
                :disabled="!isDirty"
              />
            </div>
          </UForm>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
