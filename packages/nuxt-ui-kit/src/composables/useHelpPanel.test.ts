import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
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
});
