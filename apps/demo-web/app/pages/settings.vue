<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import * as z from 'zod'
import { useDirtyTracking, type PageActionsGroup, type PageActionsItem } from '@octabits-io/nuxt-ui-kit'
import { useApi } from '~/composables/useApi'
import { call } from '~/composables/useApiCall'
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
  const { data, error } = await call(api.settings.$get())
  if (error) { toastError(error); return null }
  return data
})

if (loaded.value) resetInitial(loaded.value)

async function save() {
  saving.value = true
  try {
    // `getDirtyFields()` yields exactly the changed keys — a minimal PATCH-style
    // payload, which the server's `.partial()` body schema accepts as-is.
    const { data, error } = await call(api.settings.$put({ json: getDirtyFields() }))
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

function onRoleChange(value: DemoRole) {
  setRole(value)
  toast.add({ title: t('settings.role.switched', { role: t(`settings.role.${value}`) }) })
}

// --- Page header ----------------------------------------------------------

/**
 * A decision group: ONE question ("who am I acting as?") with mutually
 * exclusive answers, folded into a single inline control.
 *
 * This is the distinction the group exists for. As two peer buttons, "Act as
 * admin" and "Act as viewer" read as two independent things to do, sitting at
 * the same ghost weight as Save beside them. Grouped, the bar asks the question
 * once and the answers live inside it — and the same descriptor object on every
 * member is what ties them together, with the first member fixing the group's
 * position in the bar.
 */
const headerActions = computed<PageActionsItem[]>(() => {
  // Declared once and referenced by every member, as the kit asks: the first
  // member's copy defines the trigger and fixes the group's place in the bar.
  const roleGroup: PageActionsGroup = {
    id: 'role',
    label: t('settings.role.groupLabel'),
    icon: 'i-lucide-user-cog',
  }

  const roleItems: PageActionsItem[] = (['admin', 'viewer'] as const).map(value => ({
    key: `role-${value}`,
    icon: value === 'admin' ? 'i-lucide-shield-check' : 'i-lucide-eye',
    label: t(`settings.role.${value}`),
    description: t(`settings.role.${value}Hint`),
    group: roleGroup,
    // The role in effect is not an action — offering it would make the group
    // read as a radio list rather than a switch.
    disabledReason: role.value === value ? t('settings.role.current') : null,
    onSelect: () => onRoleChange(value),
  }))

  return [
    {
      key: 'save',
      icon: 'i-lucide-save',
      label: t('common.save'),
      tone: 'primary',
      visibility: 'always',
      loading: saving.value,
      disabledReason: isDirty.value ? null : t('settings.nothingToSave'),
      onSelect: () => { void save() },
    },
    ...roleItems,
    {
      key: 'reset',
      icon: 'i-lucide-undo-2',
      label: t('settings.discard'),
      visibility: 'menu',
      disabledReason: isDirty.value ? null : t('settings.nothingToSave'),
      onSelect: () => { if (loaded.value) resetInitial(loaded.value) },
    },
  ]
})
</script>

<template>
  <UDashboardPanel id="settings">
    <template #header>
      <AppPageHeader
        :title="t('settings.title')"
        :subtitle="t('settings.subtitle')"
        :utility="false"
        class="min-h-16 shrink-0 border-b border-default px-4 py-2 sm:px-6"
      >
        <template #title>
          <div class="flex min-w-0 items-center gap-2">
            <UDashboardSidebarToggle />
            <h1 class="truncate font-display text-2xl font-semibold tracking-tight">
              {{ t('settings.title') }}
            </h1>
          </div>
        </template>

        <template #badges>
          <UBadge :color="role === 'admin' ? 'primary' : 'neutral'" variant="subtle">
            {{ t(`settings.role.${role}`) }}
          </UBadge>
        </template>

        <template #actions>
          <AppPageActions :items="headerActions" :collapse-below="900" />
        </template>
      </AppPageHeader>
    </template>

    <template #body>
      <div class="flex max-w-2xl flex-col gap-6">
        <!-- The long version lives here, not in the header: a header subtitle
             is chrome, and one long enough to push the action bar onto a second
             row costs more than it explains. -->
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

            <!-- Saving lives in the header: one solid primary per state, and
                 this page's state has exactly one next step. -->
            <p class="text-xs text-muted">{{ t('settings.saveHint') }}</p>
          </UForm>
        </UPageCard>

        <UPageCard
          :title="t('settings.role.title')"
          :description="t('settings.role.description')"
          variant="subtle"
        >
          <p class="text-sm text-muted">
            {{ t('settings.role.activeIs', { role: t(`settings.role.${role}`) }) }}
          </p>
        </UPageCard>
      </div>
    </template>
  </UDashboardPanel>
</template>
