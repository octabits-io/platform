<script setup lang="ts">
/**
 * Live events — the kit's `@octabits-io/nuxt-ui-kit/events` surface against
 * the demo server's `/api/events/stream` SSE endpoint.
 *
 * What this page demonstrates:
 *
 * - `useEventStream`: one connection for the page's lifetime, reactive
 *   connection state (the badge), automatic reconnect with backoff. The
 *   server closes every stream after its age cap — watch the badge flick
 *   through `reconnecting` and back without losing events (the durable lane
 *   replays via `Last-Event-ID`).
 * - The two lanes side by side: durable emits survive a reconnect (replayed
 *   from the outbox watermark), ephemeral emits are best-effort and vanish if
 *   the stream is down.
 * - Dedupe: replay overlap after a reconnect does not produce duplicate rows
 *   here — the client filters by envelope id before `onEvent`.
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useEventStream, type StreamedEvent } from '@octabits-io/nuxt-ui-kit/events'
import { useApi, useApiBase } from '~/composables/useApi'
import { call } from '~/composables/useApiCall'
import { useApiError } from '~/composables/useApiError'
import { useDateFormat } from '~/composables/useDateFormat'

const { t } = useI18n()
const { api } = useApi()
const { toastError } = useApiError()
const { formatDateTime } = useDateFormat()

interface ReceivedEvent extends StreamedEvent {
  receivedAt: string
}

const events = ref<ReceivedEvent[]>([])

// `resolveApiBaseUrl` semantics via useApiBase — NOT the raw runtimeConfig
// value, which is '' in dev and would aim the stream at the Nuxt dev server
// (whose SPA fallback answers 200 text/html for any path).
const apiBase = useApiBase()

const stream = useEventStream({
  buildRequest: () => ({
    // A real app puts its Authorization header here, fresh per attempt —
    // that is the whole reason the client is fetch-based.
    url: `${apiBase}/api/events/stream?user=demo-web`,
  }),
  onEvent: (event) => {
    events.value = [{ ...event, receivedAt: new Date().toISOString() }, ...events.value].slice(0, 50)
  },
})
stream.start()

const emitting = ref(false)

async function emitDemo(lane: 'durable' | 'ephemeral') {
  emitting.value = true
  try {
    const { error } = await call(api.events.demo.$post({ json: { lane, message: t('events.demoMessage') } }))
    if (error) toastError(error)
  } finally {
    emitting.value = false
  }
}

const stateColor = {
  idle: 'neutral',
  connecting: 'info',
  connected: 'success',
  reconnecting: 'warning',
  degraded: 'error',
  stopped: 'neutral',
} as const
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold">{{ t('events.title') }}</h1>
        <p class="text-sm text-muted">{{ t('events.subtitle') }}</p>
      </div>
      <UBadge :color="stateColor[stream.state.value]" variant="subtle" size="lg">
        {{ t(`events.state.${stream.state.value}`) }}
      </UBadge>
    </div>

    <div class="flex flex-wrap items-center gap-3">
      <UButton
        icon="i-lucide-database"
        :label="t('events.emitDurable')"
        :loading="emitting"
        @click="emitDemo('durable')"
      />
      <UButton
        icon="i-lucide-zap"
        variant="soft"
        :label="t('events.emitEphemeral')"
        :loading="emitting"
        @click="emitDemo('ephemeral')"
      />
      <span class="text-sm text-muted">{{ t('events.receivedCount', { count: stream.received.value }) }}</span>
    </div>

    <UCard>
      <div v-if="events.length === 0" class="py-8 text-center text-sm text-muted">
        {{ t('events.empty') }}
      </div>
      <ul v-else class="divide-y divide-default">
        <li v-for="event in events" :key="event.id" class="flex items-center gap-3 py-2 text-sm">
          <UBadge :color="event.lane === 'durable' ? 'primary' : 'neutral'" variant="subtle" size="sm">
            {{ event.lane }}
          </UBadge>
          <code class="font-mono text-xs">{{ event.type }}</code>
          <span v-if="event.seq !== undefined" class="text-xs text-muted">seq {{ event.seq }}</span>
          <span class="ml-auto text-xs text-muted">{{ formatDateTime(event.receivedAt) }}</span>
        </li>
      </ul>
    </UCard>
  </div>
</template>
