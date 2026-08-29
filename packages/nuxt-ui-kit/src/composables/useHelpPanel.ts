import {
  computed,
  getCurrentInstance,
  reactive,
  ref,
  watch,
  type Component,
  type ComponentInternalInstance,
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
  /**
   * Register help actions for a tab. Returns a disposer that removes *this*
   * registration and no other — safe to call after the tab has been claimed by
   * a later component, where it is a no-op.
   */
  register(tabValue: string, actions: HelpPanelAction[]): () => void;
  /**
   * Unregister help actions for a tab.
   *
   * Only the component that registered the tab can remove it (see the
   * ownership note on `useHelpPanel`). Registrations made outside a component
   * have no owner and are removed unconditionally.
   */
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
 *
 * **A registration belongs to the component that made it.** Where one registry
 * is shared across routes, two components routinely share a tab value, and
 * teardown of the old one interleaves with setup of the new — so removal is
 * owner-checked rather than by key alone. Prefer the disposer `register`
 * returns; `unregister(tab)` is equivalent and stays for existing callers.
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

  /**
   * Which component owns each tab's registration.
   *
   * Consumers key registrations by *surface*, so several pages legitimately
   * share one tab value (an admin console where every flat page registers
   * `'detail'` is the motivating case). On a client-side navigation Vue runs
   * the INCOMING component's `setup()` before the outgoing one's
   * `onUnmounted`, so the calls arrive as: new registers, old unregisters. A
   * delete-by-key therefore let a departing component remove its successor's
   * registration, and the help trigger vanished for the rest of the session —
   * every arrival wiped by the page it had just replaced.
   */
  const owners = new Map<string, ComponentInternalInstance | null>();

  function remove(tabValue: string, caller: ComponentInternalInstance | null) {
    // An unowned registration (registered outside a component, e.g. in a test)
    // keeps the old unconditional behaviour.
    if (owners.has(tabValue) && owners.get(tabValue) !== caller) return;
    owners.delete(tabValue);
    registrations.delete(tabValue);
  }

  function register(tabValue: string, actions: HelpPanelAction[]) {
    const owner = getCurrentInstance();
    // Re-registering from a watcher (no current instance) must not orphan the
    // tab — the owner recorded by the original in-setup call still holds.
    if (owner) owners.set(tabValue, owner);
    registrations.set(tabValue, { actions });
    return () => {
      remove(tabValue, owner);
    };
  }

  function unregister(tabValue: string) {
    remove(tabValue, getCurrentInstance());
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
