<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useApi, useApiBase } from '~/composables/useApi'
import { useDemoRole } from '~/composables/useDemoRole'
import { useAuthStore } from '~/stores/auth'

const { t } = useI18n()
const { api } = useApi()
const auth = useAuthStore()
const { role } = useDemoRole()

// `/health` sits outside the `/api` prefix, so it hangs off the client root
// rather than `api` — plain fetch, because Eden's typed tree covers the routes
// but the readiness probe is the one endpoint worth reading even when the whole
// API is down.
const { data: health } = await useAsyncData('health', async () => {
  try {
    const res = await fetch(`${useApiBase()}/health/ready`)
    return (await res.json()) as { status: string, db: string }
  } catch {
    return null
  }
})

const { data: queue } = await useAsyncData('queue-stats', async () => {
  const { data } = await api.queue.stats.get()
  return data
})

const { data: settings } = await useAsyncData('dashboard-settings', async () => {
  const { data } = await api.settings.get()
  return data
})
</script>

<template>
  <UDashboardPanel id="dashboard">
    <template #header>
      <UDashboardNavbar :title="t('dashboard.title')" />
    </template>

    <template #body>
      <div class="grid gap-4 sm:grid-cols-2">
        <UPageCard
          :title="t('dashboard.health.title')"
          :description="t('dashboard.health.description')"
          variant="subtle"
        >
          <div v-if="health" class="flex flex-col gap-1">
            <UBadge color="success" variant="subtle" icon="i-lucide-check" class="w-fit">
              {{ t('dashboard.health.ok') }}
            </UBadge>
            <p class="text-sm text-muted">
              {{ t('dashboard.health.db', { status: health.db }) }}
            </p>
          </div>
          <UBadge v-else color="error" variant="subtle" icon="i-lucide-x" class="w-fit">
            {{ t('dashboard.health.down') }}
          </UBadge>
        </UPageCard>

        <UPageCard
          :title="t('dashboard.session.title')"
          :description="t('dashboard.session.description')"
          variant="subtle"
        >
          <div class="flex flex-col gap-1 text-sm">
            <p class="font-medium">{{ auth.user?.name }}</p>
            <p class="text-muted">{{ auth.user?.email }}</p>
            <p class="text-muted">
              {{ t('dashboard.session.role') }}:
              <UBadge :color="role === 'admin' ? 'primary' : 'neutral'" variant="subtle" size="sm">
                {{ role }}
              </UBadge>
            </p>
          </div>
        </UPageCard>

        <UPageCard
          :title="t('dashboard.queue.title')"
          :description="t('dashboard.queue.description')"
          variant="subtle"
          class="sm:col-span-2"
        >
          <div v-if="queue?.queues?.length" class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="text-left text-muted">
                <tr>
                  <th class="py-1 pr-4 font-medium">{{ t('dashboard.queue.queue') }}</th>
                  <th class="py-1 pr-4 font-medium">{{ t('dashboard.queue.deferred') }}</th>
                  <th class="py-1 pr-4 font-medium">{{ t('dashboard.queue.queued') }}</th>
                  <th class="py-1 pr-4 font-medium">{{ t('dashboard.queue.active') }}</th>
                  <th class="py-1 font-medium">{{ t('dashboard.queue.total') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="q in queue.queues" :key="q.name" class="border-t border-default">
                  <td class="py-1.5 pr-4 font-mono text-xs">{{ q.name }}</td>
                  <td class="py-1.5 pr-4 tabular-nums">{{ q.deferredCount }}</td>
                  <td class="py-1.5 pr-4 tabular-nums">{{ q.queuedCount }}</td>
                  <td class="py-1.5 pr-4 tabular-nums">{{ q.activeCount }}</td>
                  <td class="py-1.5 tabular-nums">{{ q.totalCount }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="text-sm text-muted">{{ t('common.none') }}</p>
        </UPageCard>

        <UPageCard
          :title="t('dashboard.settings.title')"
          :description="t('dashboard.settings.description')"
          variant="subtle"
          class="sm:col-span-2"
        >
          <div v-if="settings" class="flex flex-col gap-2 text-sm">
            <div class="flex flex-wrap gap-x-2">
              <span class="text-muted">{{ t('settings.fields.supportEmail') }}:</span>
              <span class="font-medium">{{ settings.supportEmail }}</span>
            </div>
            <div class="flex flex-wrap gap-x-2">
              <span class="text-muted">{{ t('settings.fields.welcomeSubject') }}:</span>
              <span class="font-medium">{{ settings.welcomeSubject }}</span>
            </div>
            <UButton
              :label="t('dashboard.settings.manage')"
              to="/settings"
              variant="link"
              trailing-icon="i-lucide-arrow-right"
              class="w-fit px-0"
            />
          </div>
        </UPageCard>
      </div>
    </template>
  </UDashboardPanel>
</template>
