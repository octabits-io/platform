// The ownership tests mount real components — `getCurrentInstance()` is what
// identifies a registration's owner, and only a mounted component has one.
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick, onUnmounted } from 'vue';
import { mount } from '@vue/test-utils';
import { useHelpPanel } from './useHelpPanel.ts';

const stubComponent = defineComponent({ render: () => h('div') });
const action = (key: string) => ({
  key,
  label: key,
  icon: 'i-lucide-circle-help',
  component: stubComponent,
  props: {},
});

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

describe('useHelpPanel', () => {
  it('surfaces actions for the active tab only', () => {
    const panel = useHelpPanel({ storage: memoryStorage() });
    panel.register('general', [action('faq')]);
    panel.register('pricing', [action('pricing-help')]);

    panel.setActiveTab('general');
    expect(panel.hasActions.value).toBe(true);
    expect(panel.currentActions.value.map((a) => a.key)).toEqual(['faq']);

    panel.setActiveTab('pricing');
    expect(panel.currentActions.value.map((a) => a.key)).toEqual(['pricing-help']);
  });

  it('reports no actions for unregistered or unregistered-again tabs', () => {
    const panel = useHelpPanel({ storage: memoryStorage() });
    panel.setActiveTab('nowhere');
    expect(panel.hasActions.value).toBe(false);

    panel.register('general', [action('faq')]);
    panel.setActiveTab('general');
    panel.unregister('general');
    expect(panel.hasActions.value).toBe(false);
  });

  it('auto-closes when switching to a tab without registrations', () => {
    const panel = useHelpPanel({ storage: memoryStorage() });
    panel.register('general', [action('faq')]);
    panel.setActiveTab('general');
    panel.toggle();
    expect(panel.isOpen.value).toBe(true);

    panel.setActiveTab('other');
    expect(panel.isOpen.value).toBe(false);
  });

  it('persists the open state under the configured storage key', () => {
    const storage = memoryStorage();
    const panel = useHelpPanel({ storageKey: 'app-help', storage });
    panel.toggle();
    // watch flushes are async in components but sync-queued here via effect scope;
    // read after a microtask-free check: the ref itself changed
    expect(panel.isOpen.value).toBe(true);
  });

  it('restores the persisted open state', () => {
    const storage = memoryStorage({ 'app-help': 'true' });
    const panel = useHelpPanel({ storageKey: 'app-help', storage });
    expect(panel.isOpen.value).toBe(true);
  });

  describe('registration ownership', () => {
    /**
     * The navigation interleaving this guards: Vue runs the incoming
     * component's setup() BEFORE the outgoing component's onUnmounted, so the
     * calls arrive as register(new) → unregister(old). Deleting by key alone
     * let the departing page remove its successor's registration.
     */
    function pageComponent(panel: ReturnType<typeof useHelpPanel>, key: string) {
      return defineComponent({
        setup() {
          panel.register('detail', [action(key)]);
          onUnmounted(() => panel.unregister('detail'));
          return () => h('div');
        },
      });
    }

    it('keeps the incoming page when the outgoing page tears down after it', async () => {
      const panel = useHelpPanel({ storage: memoryStorage() });
      panel.setActiveTab('detail');

      const outgoing = mount(pageComponent(panel, 'owners-help'));
      expect(panel.currentActions.value.map((a) => a.key)).toEqual(['owners-help']);

      // Incoming registers first…
      const incoming = mount(pageComponent(panel, 'customers-help'));
      // …then the outgoing one unmounts, as it does on a client-side route change.
      outgoing.unmount();
      await nextTick();

      expect(panel.currentActions.value.map((a) => a.key)).toEqual(['customers-help']);
      expect(panel.hasActions.value).toBe(true);

      incoming.unmount();
      await nextTick();
      expect(panel.hasActions.value).toBe(false);
    });

    it('drops the registration when its owner unmounts with no successor', async () => {
      const panel = useHelpPanel({ storage: memoryStorage() });
      panel.setActiveTab('detail');

      const page = mount(pageComponent(panel, 'owners-help'));
      expect(panel.hasActions.value).toBe(true);

      page.unmount();
      await nextTick();
      expect(panel.hasActions.value).toBe(false);
    });

    it("ignores a stale disposer once another component owns the tab", () => {
      const panel = useHelpPanel({ storage: memoryStorage() });
      panel.setActiveTab('detail');

      const first = mount(defineComponent({
        setup() {
          const dispose = panel.register('detail', [action('first')]);
          return { dispose };
        },
        render: () => h('div'),
      }));
      const dispose = (first.vm as unknown as { dispose: () => void }).dispose;

      mount(pageComponent(panel, 'second'));
      dispose();

      expect(panel.currentActions.value.map((a) => a.key)).toEqual(['second']);
    });

    it('removes an unowned registration unconditionally', () => {
      const panel = useHelpPanel({ storage: memoryStorage() });
      panel.register('general', [action('faq')]);
      panel.setActiveTab('general');
      panel.unregister('general');
      expect(panel.hasActions.value).toBe(false);
    });
  });
});
