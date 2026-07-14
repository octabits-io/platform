<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { NavigationMenuItem } from '@nuxt/ui'
import { useAuthStore } from '~/stores/auth'
import { useDemoRole } from '~/composables/useDemoRole'

const { t } = useI18n()
const auth = useAuthStore()
const router = useRouter()
const { role, loadPersisted } = useDemoRole()

onMounted(loadPersisted)

const links = computed<NavigationMenuItem[][]>(() => [[
  { label: t('nav.dashboard'), icon: 'i-lucide-layout-dashboard', to: '/dashboard' },
  { label: t('nav.contacts'), icon: 'i-lucide-users', to: '/contacts' },
  { label: t('nav.notes'), icon: 'i-lucide-notebook-pen', to: '/notes' },
  { label: t('nav.files'), icon: 'i-lucide-paperclip', to: '/files' },
  { label: t('nav.settings'), icon: 'i-lucide-settings', to: '/settings' },
]])

async function onLogout() {
  await auth.logout()
  await router.push('/login')
}
</script>

<template>
  <UDashboardGroup>
    <UDashboardSidebar collapsible resizable :default-size="18" :min-size="14" :max-size="26">
      <template #header="{ collapsed }">
        <div class="flex items-center gap-2 min-w-0">
          <UIcon name="i-lucide-contact-round" class="size-5 shrink-0 text-primary" />
          <div v-if="!collapsed" class="min-w-0">
            <p class="truncate font-display text-sm font-semibold">{{ t('app.name') }}</p>
            <p class="truncate text-xs text-muted">{{ t('app.tagline') }}</p>
          </div>
        </div>
      </template>

      <template #default="{ collapsed }">
        <UNavigationMenu
          orientation="vertical"
          :items="links"
          :collapsed="collapsed"
          popover
        />
      </template>

      <template #footer="{ collapsed }">
        <div class="flex w-full flex-col gap-2">
          <UUser
            :name="collapsed ? undefined : (auth.user?.name ?? undefined)"
            :description="collapsed ? undefined : `${t('dashboard.session.role')}: ${role}`"
            :avatar="{ alt: auth.user?.name ?? 'user' }"
            size="sm"
          />
          <UButton
            :label="collapsed ? undefined : t('nav.logout')"
            icon="i-lucide-log-out"
            color="neutral"
            variant="ghost"
            :block="!collapsed"
            :square="collapsed"
            class="justify-start"
            @click="onLogout"
          />
        </div>
      </template>
    </UDashboardSidebar>

    <slot />

    <!-- Mounted once, app-wide: the kit's confirm dialog is a module-scoped
         singleton that any page can await via useConfirm(). -->
    <AppConfirmDialog />
  </UDashboardGroup>
</template>
