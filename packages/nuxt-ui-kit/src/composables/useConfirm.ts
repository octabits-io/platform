import { ref } from 'vue';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  /** Renders the confirm button in the error color. */
  dangerous?: boolean;
}

// Module-scoped singleton state: one dialog instance per app, any caller can
// await it. The renderer component (components/ConfirmDialog.vue) consumes
// useConfirmState; feature code calls useConfirm().confirm(...).
const isOpen = ref(false);
const currentOptions = ref<ConfirmOptions>({ title: '' });
let resolvePromise: ((value: boolean) => void) | null = null;

/** Promise-based confirmation: `if (await confirm({ title, dangerous: true })) …` */
export function useConfirm() {
  function confirm(options: ConfirmOptions): Promise<boolean> {
    currentOptions.value = options;
    isOpen.value = true;
    return new Promise((resolve) => {
      resolvePromise = resolve;
    });
  }

  return { confirm };
}

/** State + handlers for the dialog renderer component. */
export function useConfirmState() {
  function handleConfirm() {
    isOpen.value = false;
    resolvePromise?.(true);
    resolvePromise = null;
  }

  function handleCancel() {
    isOpen.value = false;
    resolvePromise?.(false);
    resolvePromise = null;
  }

  return {
    isOpen,
    options: currentOptions,
    handleConfirm,
    handleCancel,
  };
}
