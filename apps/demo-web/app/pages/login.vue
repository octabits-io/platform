<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { seedDemoSession } from '~/lib/bypass'
import { useAuthStore } from '~/stores/auth'

// `/login` is public by the kit guard's default `isPublicRoute`.
definePageMeta({ layout: false })

const { t } = useI18n()
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const loading = ref(false)

async function signIn() {
  loading.value = true
  try {
    // A real app calls `auth.login(returnUrl)` here, which starts the OIDC
    // signin redirect. With no IdP, the demo re-seeds the bypass session and
    // re-runs the same `checkAuth()` the guard would.
    seedDemoSession()
    await auth.checkAuth()
    const redirect = route.query.redirect
    await router.push(typeof redirect === 'string' ? redirect : '/dashboard')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center p-4">
    <UPageCard class="w-full max-w-md">
      <div class="flex flex-col gap-4">
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-contact-round" class="size-6 text-primary" />
          <h1 class="font-display text-xl font-semibold">{{ t('app.name') }}</h1>
        </div>

        <p class="text-sm text-muted">{{ t('login.description') }}</p>

        <UButton
          :label="t('login.action')"
          icon="i-lucide-log-in"
          size="lg"
          block
          :loading="loading"
          @click="signIn"
        />

        <UAlert
          icon="i-lucide-shield-alert"
          color="neutral"
          variant="subtle"
          :description="t('login.productionNotice')"
        />
      </div>
    </UPageCard>
  </div>
</template>
