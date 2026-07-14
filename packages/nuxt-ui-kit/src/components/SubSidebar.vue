<script setup lang="ts">
// Shipped as source: the consumer's Vite compiles this SFC. All imports are
// explicit — no reliance on the consumer's auto-import configuration.
import { ref, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import USlideover from '@nuxt/ui/components/Slideover.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'

const props = withDefaults(defineProps<{
  title: string
  toggleLabel?: string
  width?: string
  loading?: boolean
  headerless?: boolean
  /**
   * Query param that carries the current selection (sidebar-view convention,
   * e.g. `?s=owner:42`) — the mobile slideover auto-closes when it changes.
   */
  selectionQueryKey?: string
}>(), {
  width: 'w-[240px]',
  selectionQueryKey: 's',
})

const open = ref(false)
const route = useRoute()

const buttonLabel = computed(() => props.toggleLabel ?? props.title)

watch(
  () => [route.path, route.query[props.selectionQueryKey]],
  () => { open.value = false },
)
</script>

<template>
  <div class="flex h-full w-full flex-col overflow-hidden">
    <!-- Page header zone: rendered once (unlike #sidebar), full width above both columns -->
    <div v-if="$slots.header" class="shrink-0">
      <slot name="header" />
    </div>

    <div class="flex min-h-0 w-full flex-1 overflow-hidden">
      <USlideover v-model:open="open" side="left" :title="title">
        <template #body>
          <div class="flex h-full flex-col">
            <div v-if="loading" class="flex flex-1 items-center justify-center">
              <UIcon name="i-lucide-loader-2" class="size-6 animate-spin text-primary" />
            </div>
            <slot v-else name="sidebar" />
          </div>
        </template>
      </USlideover>

      <aside
        :class="['hidden shrink-0 flex-col overflow-hidden border-r border-default lg:flex', width]"
      >
        <div v-if="!headerless" class="border-b border-default px-4 py-3">
          <h2 class="font-display text-lg font-semibold tracking-tight">{{ title }}</h2>
        </div>
        <div v-if="loading" class="flex flex-1 items-center justify-center">
          <UIcon name="i-lucide-loader-2" class="size-6 animate-spin text-primary" />
        </div>
        <slot v-else name="sidebar" />
      </aside>

      <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div class="flex shrink-0 items-center gap-2 border-b border-default px-3 py-2 lg:hidden">
          <UButton
            :label="buttonLabel"
            icon="i-lucide-panel-left-open"
            color="neutral"
            variant="outline"
            size="sm"
            @click="open = true"
          />
        </div>
        <div class="min-w-0 flex-1 overflow-y-auto">
          <slot />
        </div>
      </div>
    </div>
  </div>
</template>
