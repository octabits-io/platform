<script setup lang="ts">
import { computed, h, ref, resolveComponent } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TableColumn } from '@nuxt/ui'
import { useApi, useApiBase } from '~/composables/useApi'
import { useApiError } from '~/composables/useApiError'

const { t } = useI18n()
const { api } = useApi()
const { toastError } = useApiError()
const toast = useToast()
const apiBase = useApiBase()

const UButton = resolveComponent('UButton')

interface StoredFile {
  id: string
  name: string
  size: number
  contentType: string
}

const files = ref<StoredFile[]>([])
const loading = ref(false)
const uploading = ref(false)
const selected = ref<File | null>(null)

async function load() {
  loading.value = true
  try {
    const { data, error } = await api.files.get()
    if (error) { toastError(error); return }
    files.value = data.items
  } finally {
    loading.value = false
  }
}

await load()

async function upload() {
  const file = selected.value
  if (!file) return
  uploading.value = true
  try {
    // Eden handles multipart natively: a `File` anywhere in the body switches
    // it to FormData, which lines up with the server's `t.Object({ file: t.File() })`.
    // No manual FormData, and the field name is still type-checked.
    const { data, error } = await api.files.post({ file })
    if (error) { toastError(error); return }
    // Same upstream narrowing wrinkle as the welcome route in contacts.vue:
    // 201 is the only declared success code, so Elysia's inferred `200` folds
    // the error body into `data`'s union. See the README's findings section.
    if (!('name' in data)) return
    toast.add({ title: t('files.uploaded', { name: data.name }), color: 'success' })
    selected.value = null
    await load()
  } finally {
    uploading.value = false
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const columns = computed<TableColumn<StoredFile>[]>(() => [
  { accessorKey: 'name', header: t('files.columns.name') },
  {
    accessorKey: 'contentType',
    header: t('files.columns.contentType'),
    cell: ({ row }) => h('span', { class: 'font-mono text-xs' }, row.original.contentType),
  },
  {
    accessorKey: 'size',
    header: t('files.columns.size'),
    cell: ({ row }) => formatSize(row.original.size),
  },
  {
    id: 'actions',
    header: '',
    cell: ({ row }) =>
      h('div', { class: 'flex justify-end' }, [
        // A plain link, not an Eden call: the download route streams bytes with
        // ETag/304 handling and `Content-Disposition: attachment`, which is the
        // browser's job to honour, not a fetch wrapper's.
        h(UButton, {
          label: t('files.download'),
          icon: 'i-lucide-download',
          color: 'neutral',
          variant: 'ghost',
          size: 'sm',
          to: `${apiBase}/api/files/${row.original.id}`,
          external: true,
        }),
      ]),
  },
])
</script>

<template>
  <UDashboardPanel id="files">
    <template #header>
      <UDashboardNavbar :title="t('files.title')" />
    </template>

    <template #body>
      <div class="flex flex-col gap-4">
        <p class="text-sm text-muted">{{ t('files.description') }}</p>

        <div class="flex flex-wrap items-center gap-2">
          <UFileUpload
            v-model="selected"
            :label="t('files.upload')"
            class="grow max-w-md"
          />
          <UButton
            :label="uploading ? t('files.uploading') : t('files.upload')"
            icon="i-lucide-upload"
            :loading="uploading"
            :disabled="!selected"
            @click="upload"
          />
        </div>

        <UTable :data="files" :columns="columns" :loading="loading">
          <template #empty>
            <p class="py-6 text-center text-sm text-muted">{{ t('files.empty') }}</p>
          </template>
        </UTable>
      </div>
    </template>
  </UDashboardPanel>
</template>
