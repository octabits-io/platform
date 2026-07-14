<script setup lang="ts">
// Shipped as source: the consumer's Vite compiles this SFC. All imports are
// explicit — no reliance on the consumer's auto-import configuration. The
// composable comes from the package root (self-reference) so its singleton
// dialog state is shared with feature code calling useConfirm().
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import UModal from '@nuxt/ui/components/Modal.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import { useConfirmState } from '@octabits-io/nuxt-ui-kit'

const props = defineProps<{
  /**
   * Tailwind z-index class applied to overlay + content (e.g. `z-[100]`) so
   * the dialog stacks above slideovers/modals that triggered it.
   */
  zIndexClass?: string
  /** i18n key for the cancel button default. */
  cancelTextKey?: string
  /** i18n key for the confirm button default. */
  confirmTextKey?: string
}>()

const { isOpen, options, handleConfirm, handleCancel } = useConfirmState()
const { t } = useI18n()

const ui = computed(() =>
  props.zIndexClass ? { overlay: props.zIndexClass, content: props.zIndexClass } : undefined,
)
</script>

<template>
  <UModal v-model:open="isOpen" :ui="ui">
    <template #header>
      <h3 class="text-lg font-semibold">{{ options.title }}</h3>
    </template>

    <template #body>
      <p v-if="options.message" class="text-sm text-muted">
        {{ options.message }}
      </p>
    </template>

    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton
          :label="options.cancelText ?? t(props.cancelTextKey ?? 'common.cancel')"
          color="neutral"
          variant="outline"
          @click="handleCancel"
        />
        <UButton
          :label="options.confirmText ?? t(props.confirmTextKey ?? 'common.confirm')"
          :color="options.dangerous ? 'error' : 'primary'"
          @click="handleConfirm"
        />
      </div>
    </template>
  </UModal>
</template>
