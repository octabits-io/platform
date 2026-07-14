<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import * as z from 'zod'
import { useDirtyTracking } from '@octabits-io/nuxt-ui-kit'
import { useApi } from '~/composables/useApi'
import { useApiError } from '~/composables/useApiError'
import { useDemoRole, type DemoRole } from '~/composables/useDemoRole'

const { t } = useI18n()
const { api } = useApi()
const { toastError } = useApiError()
const { role, setRole } = useDemoRole()
const toast = useToast()

const state = reactive({ supportEmail: '', welcomeSubject: '' })
const saving = ref(false)

const { isDirty, getDirtyFields, resetInitial } = useDirtyTracking(state)

const schema = z.object({
  supportEmail: z.email(),
  welcomeSubject: z.string().min(1),
})

const { data: loaded } = await useAsyncData('settings', async () => {
  const { data, error } = await api.settings.get()
  if (error) { toastError(error); return null }
  return data
})

if (loaded.value) resetInitial(loaded.value)

async function save() {
  saving.value = true
  try {
    // `getDirtyFields()` yields exactly the changed keys — a minimal PATCH-style
    // payload, which the server's `.partial()` body schema accepts as-is.
    const { data, error } = await api.settings.put(getDirtyFields())
    if (error) {
      // With the viewer role this is the server's 403 (`forbidden`), which the
      // kit's messenger resolves against `errors.forbidden` in the locale file.
      // The form stays dirty, so the retry after switching to admin just works.
      toastError(error)
      return
    }
    toast.add({ title: t('settings.success'), color: 'success' })
    resetInitial(data)
  } finally {
    saving.value = false
  }
}

const roleItems = computed(() => [
  { label: t('settings.role.admin'), value: 'admin' as const },
  { label: t('settings.role.viewer'), value: 'viewer' as const },
])

function onRoleChange(value: DemoRole) {
  setRole(value)
}
</script>

<template>
  <UDashboardPanel id="settings">
    <template #header>
      <UDashboardNavbar :title="t('settings.title')" />
    </template>

    <template #body>
      <div class="flex max-w-2xl flex-col gap-6">
        <p class="text-sm text-muted">{{ t('settings.description') }}</p>

        <UPageCard :title="t('settings.sections.general')" variant="subtle">
          <UForm :schema="schema" :state="state" class="flex flex-col gap-4" @submit="save">
            <UFormField :label="t('settings.fields.supportEmail')" name="supportEmail" required>
              <UInput v-model="state.supportEmail" type="email" class="w-full" />
            </UFormField>

            <UFormField
              :label="t('settings.fields.welcomeSubject')"
              :hint="t('settings.hints.welcomeSubject')"
              name="welcomeSubject"
              required
            >
              <UInput v-model="state.welcomeSubject" class="w-full" />
            </UFormField>

            <div class="flex justify-end">
              <UButton
                type="submit"
                :label="t('common.save')"
                :loading="saving"
                :disabled="!isDirty"
              />
            </div>
          </UForm>
        </UPageCard>

        <UPageCard
          :title="t('settings.role.title')"
          :description="t('settings.role.description')"
          variant="subtle"
        >
          <URadioGroup
            :model-value="role"
            :items="roleItems"
            value-key="value"
            orientation="horizontal"
            @update:model-value="onRoleChange($event as DemoRole)"
          />
        </UPageCard>
      </div>
    </template>
  </UDashboardPanel>
</template>
