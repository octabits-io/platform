<script setup lang="ts">
import { computed, h, reactive, ref, resolveComponent } from 'vue'
import { useI18n } from 'vue-i18n'
import * as z from 'zod'
import type { TableColumn } from '@nuxt/ui'
import { useConfirm, useDirtyTracking, usePagination } from '@octabits-io/nuxt-ui-kit'
import { useApi } from '~/composables/useApi'
import { useApiError } from '~/composables/useApiError'
import { useDateFormat } from '~/composables/useDateFormat'

const { t } = useI18n()
const { api } = useApi()
const { toastError } = useApiError()
const { formatDateTime } = useDateFormat()
const { confirm } = useConfirm()
const toast = useToast()

const UButton = resolveComponent('UButton')
const UDropdownMenu = resolveComponent('UDropdownMenu')

interface Contact {
  id: string
  name: string
  email: string
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
 * ignored. `onPaginationChange` is the refetch hook.
 */
const { page, itemsPerPage, total, setTotal, resetPagination } = usePagination({
  defaultLimit: 10,
  onPaginationChange: () => { void load() },
})

async function load() {
  // A blind-index lookup is exact-match and returns at most one row, so it
  // replaces the paginated list rather than filtering it.
  if (searchActive.value) return
  loading.value = true
  try {
    const { data, error } = await api.contacts.get({
      query: { page: page.value, pageSize: itemsPerPage.value },
    })
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
    const { data, error } = await api.contacts.search.get({ query: { email } })
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

// --- Create ---------------------------------------------------------------

const createOpen = ref(false)
const createState = reactive({ name: '', email: '' })
const creating = ref(false)

// Zod messages are locale-synced by plugins/02.zod-locale.ts.
const contactSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.email(),
})

function openCreate() {
  createState.name = ''
  createState.email = ''
  createOpen.value = true
}

async function submitCreate() {
  creating.value = true
  try {
    const { error } = await api.contacts.post({ ...createState })
    if (error) { toastError(error); return }
    toast.add({ title: t('contacts.create.success'), color: 'success' })
    createOpen.value = false
    await clearSearch()
  } finally {
    creating.value = false
  }
}

// --- Edit (dirty-tracked) -------------------------------------------------

const editOpen = ref(false)
const editing = ref(false)
const editId = ref<string | null>(null)
const editState = reactive({ name: '', email: '' })

/**
 * `useDirtyTracking` snapshots the reactive state and deep-compares against it.
 * `resetInitial(values)` re-snapshots *after* assigning, which is exactly the
 * "load a record into the form" move — so opening the modal on a new contact
 * starts clean rather than instantly dirty.
 */
const { isDirty, resetInitial } = useDirtyTracking(editState)

function openEdit(contact: Contact) {
  editId.value = contact.id
  resetInitial({ name: contact.name, email: contact.email })
  editOpen.value = true
}

async function submitEdit() {
  if (!editId.value) return
  editing.value = true
  try {
    const { error } = await api.contacts({ id: editId.value }).put({ ...editState })
    if (error) { toastError(error); return }
    toast.add({ title: t('contacts.edit.success'), color: 'success' })
    resetInitial()
    editOpen.value = false
    await load()
  } finally {
    editing.value = false
  }
}

// --- Row actions ----------------------------------------------------------

async function sendWelcome(contact: Contact) {
  const { data, error } = await api.contacts({ id: contact.id }).welcome.post()
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

  const { error } = await api.contacts({ id: contact.id }).delete()
  // With the viewer role this is the server's 403 (`forbidden`), which the kit's
  // messenger maps to `errors.forbidden` from the locale file.
  if (error) { toastError(error); return }
  toast.add({ title: t('contacts.delete.success'), color: 'success' })
  await load()
}

// --- Table ----------------------------------------------------------------

const columns = computed<TableColumn<Contact>[]>(() => [
  { accessorKey: 'name', header: t('contacts.columns.name') },
  { accessorKey: 'email', header: t('contacts.columns.email') },
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
      <UDashboardNavbar :title="t('contacts.title')">
        <template #right>
          <UButton :label="t('contacts.new')" icon="i-lucide-plus" @click="openCreate" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="flex flex-col gap-4">
        <p class="text-sm text-muted">{{ t('contacts.description') }}</p>

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

        <UTable :data="rows" :columns="columns" :loading="loading" class="shrink-0">
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
