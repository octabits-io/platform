import {
  computed,
  reactive,
  ref,
  watch,
  type Component,
  type ComputedRef,
  type InjectionKey,
  type Ref,
} from 'vue';

export interface HelpPanelAction {
  /** Unique key for this action within the tab */
  key: string;
  /** Display label */
  label: string;
  /** Icon name (e.g. i-lucide-circle-help) */
  icon: string;
  /** Raw Vue component to render in the panel */
  component: Component;
  /** Props to pass to the component (should be reactive) */
  props: Record<string, unknown>;
}

export interface HelpPanelRegistration {
  actions: HelpPanelAction[];
}

export interface HelpPanel {
  /** Map of tab value -> registration */
  registrations: Map<string, HelpPanelRegistration>;
  /** Whether the panel is open */
  isOpen: Ref<boolean>;
  /** Currently active tab value */
  activeTabValue: Ref<string>;
  /** Actions for the currently active tab */
  currentActions: ComputedRef<HelpPanelAction[]>;
  /** Whether the active tab has any help actions */
  hasActions: ComputedRef<boolean>;
  /** Register help actions for a tab */
  register(tabValue: string, actions: HelpPanelAction[]): void;
  /** Unregister help actions for a tab */
  unregister(tabValue: string): void;
  /** Set the currently active tab */
  setActiveTab(tabValue: string): void;
  /** Toggle the panel open/closed */
  toggle(): void;
}

export const HELP_PANEL_KEY: InjectionKey<HelpPanel> = Symbol('help-panel');

export interface HelpPanelOptions {
  /** localStorage key persisting the open state. Default `help-panel-open`. */
  storageKey?: string;
  /** Storage override (tests). Default `globalThis.localStorage`. */
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
}

/**
 * Provide/inject registry for a per-tab contextual help panel: pages register
 * help actions keyed by tab, `PageUtilityActions` renders the toggle, and a
 * panel component renders `currentActions`. Open state persists to
 * localStorage; switching to a tab without actions auto-closes the panel.
 *
 * Provide it per page: `provide(HELP_PANEL_KEY, useHelpPanel())`.
 */
export function useHelpPanel(options: HelpPanelOptions = {}): HelpPanel {
  const storageKey = options.storageKey ?? 'help-panel-open';
  const storage = options.storage ?? globalThis.localStorage;

  const isOpen = ref(storage?.getItem(storageKey) === 'true');
  watch(isOpen, (open) => storage?.setItem(storageKey, String(open)));

  const registrations = reactive(new Map<string, HelpPanelRegistration>());
  const activeTabValue = ref('');

  const currentActions = computed<HelpPanelAction[]>(() => {
    const reg = registrations.get(activeTabValue.value);
    return reg?.actions ?? [];
  });

  const hasActions = computed(() => currentActions.value.length > 0);

  function register(tabValue: string, actions: HelpPanelAction[]) {
    registrations.set(tabValue, { actions });
  }

  function unregister(tabValue: string) {
    registrations.delete(tabValue);
  }

  function setActiveTab(tabValue: string) {
    activeTabValue.value = tabValue;
    // Auto-close when switching to a tab without help actions
    if (!registrations.has(tabValue)) {
      isOpen.value = false;
    }
  }

  function toggle() {
    isOpen.value = !isOpen.value;
  }

  return {
    registrations,
    isOpen,
    activeTabValue,
    currentActions,
    hasActions,
    register,
    unregister,
    setActiveTab,
    toggle,
  };
}
