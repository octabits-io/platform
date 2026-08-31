<script setup lang="ts">
/**
 * The contextual help panel — the half the kit deliberately does NOT ship.
 *
 * `useHelpPanel` is a registry plus an open flag: pages register actions per
 * tab, `PageActions`/`PageUtilityActions` render the trigger, and *rendering*
 * is the app's job, because where help belongs (a side rail here, a slideover
 * on mobile, a drawer in a modal) is a layout decision no library can make.
 *
 * Reading `help.isOpen.value` rather than `help.isOpen` is not a slip: the
 * registry is a plain object, so its refs are not unwrapped by the template
 * compiler the way a setup-returned ref would be.
 */
import { inject } from 'vue'
import { HELP_PANEL_KEY } from '@octabits-io/nuxt-ui-kit'

const help = inject(HELP_PANEL_KEY, null)
</script>

<template>
  <aside
    v-if="help?.isOpen.value && help.currentActions.value.length"
    class="hidden w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-default bg-elevated/30 p-4 lg:flex"
  >
    <section v-for="action in help.currentActions.value" :key="action.key" class="flex flex-col gap-2">
      <h2 class="flex items-center gap-2 text-sm font-semibold">
        <UIcon :name="action.icon" class="size-4 shrink-0 text-primary" />
        {{ action.label }}
      </h2>
      <!-- Raw component + props, exactly as registered. -->
      <component :is="action.component" v-bind="action.props" />
    </section>
  </aside>
</template>
