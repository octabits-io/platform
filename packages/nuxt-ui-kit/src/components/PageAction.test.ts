// Mounts a kit SFC — the first tests in this package to do so (see
// `vitest.config.ts`; `@nuxt/ui` is stubbed below so no vendor SFC compiles).
// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';

/**
 * `PageAction` is where the header's conventions become DOM: the tooltip
 * wrapper for icon-only buttons, and the blocked state — a button that LOOKS
 * disabled must BE disabled. That second one shipped broken (a blocked button
 * leaked its click to the parent through the hover span), which is exactly the
 * class of bug typechecking cannot see and only a mount can.
 *
 * The `@nuxt/ui` primitives are stubbed rather than compiled: they need an app
 * context (`TooltipProvider`) the kit does not own, and what is under test is
 * what the kit PASSES them.
 */
vi.mock('@nuxt/ui/components/Button.vue', () => ({
  default: defineComponent({
    name: 'UButtonStub',
    inheritAttrs: false,
    props: {
      icon: String,
      label: String,
      size: String,
      color: String,
      variant: String,
      loading: Boolean,
      disabled: Boolean,
      to: [String, Object],
      target: String,
    },
    setup(props, { attrs, slots }) {
      return () =>
        h(
          'button',
          {
            ...attrs,
            'data-icon': props.icon,
            'data-color': props.color,
            'data-variant': props.variant,
            'data-size': props.size,
            'data-loading': String(props.loading ?? false),
            disabled: props.disabled || undefined,
          },
          [props.label, slots.default?.()],
        );
    },
  }),
}));

vi.mock('@nuxt/ui/components/Tooltip.vue', () => ({
  default: defineComponent({
    name: 'UTooltipStub',
    props: { text: String, disabled: Boolean },
    setup(props, { slots }) {
      return () =>
        h('span', { 'data-tooltip': props.text, 'data-tooltip-disabled': String(props.disabled ?? false) }, slots.default?.());
    },
  }),
}));

import PageAction from './PageAction.vue';

describe('PageAction', () => {
  it('renders an icon-only button inside a tooltip carrying the label', () => {
    const wrapper = mount(PageAction, { props: { icon: 'i-lucide-pencil', label: 'Edit' } });

    expect(wrapper.find('[data-tooltip="Edit"]').exists()).toBe(true);
    // The label is the accessible name; it must not also render as text.
    expect(wrapper.get('button').attributes('aria-label')).toBe('Edit');
    expect(wrapper.text()).toBe('');
  });

  it('renders the label inline with show-label, and drops the tooltip', () => {
    const wrapper = mount(PageAction, {
      props: { icon: 'i-lucide-pencil', label: 'Edit', showLabel: true },
    });

    expect(wrapper.text()).toContain('Edit');
    expect(wrapper.find('[data-tooltip]').exists()).toBe(false);
  });

  it('maps tone to colour/variant, with primary solid', () => {
    const neutral = mount(PageAction, { props: { icon: 'i', label: 'A' } });
    expect(neutral.get('button').attributes('data-color')).toBe('neutral');
    expect(neutral.get('button').attributes('data-variant')).toBe('ghost');

    const primary = mount(PageAction, { props: { icon: 'i', label: 'A', tone: 'primary' } });
    expect(primary.get('button').attributes('data-color')).toBe('primary');
    expect(primary.get('button').attributes('data-variant')).toBe('solid');
  });

  it('disables the button while loading', () => {
    const wrapper = mount(PageAction, { props: { icon: 'i', label: 'Save', loading: true } });

    expect(wrapper.get('button').attributes('disabled')).toBeDefined();
    expect(wrapper.get('button').attributes('data-loading')).toBe('true');
  });

  describe('blocked with a reason', () => {
    const blocked = () =>
      mount(PageAction, {
        props: {
          icon: 'i-lucide-pencil',
          label: 'Edit',
          showLabel: true,
          disabledReason: 'Select a contact first',
        },
        attrs: { onClick: vi.fn() },
      });

    it('shows "label — reason" and disables the button', () => {
      const wrapper = blocked();

      expect(wrapper.get('[data-tooltip]').attributes('data-tooltip')).toBe(
        'Edit — Select a contact first',
      );
      expect(wrapper.get('button').attributes('disabled')).toBeDefined();
      expect(wrapper.get('button').attributes('aria-label')).toBe('Edit — Select a contact first');
    });

    it('opts the button out of pointer events, so the hover span can own them', () => {
      // The span is the hover target (a disabled button dispatches none); the
      // button must therefore not be clickable underneath it.
      expect(blocked().get('button').classes()).toContain('pointer-events-none');
    });

    it('never fires a click handler — the bug this component shipped with', () => {
      const onClick = vi.fn();
      const wrapper = mount(PageAction, {
        props: { icon: 'i', label: 'Edit', showLabel: true, disabledReason: 'Blocked' },
        attrs: { onClick },
      });

      wrapper.get('button').trigger('click');
      wrapper.get('span').trigger('click');

      // `inheritAttrs: false` is what keeps the handler off the hover span,
      // where an inherited @click used to land and fire the parent's action.
      expect(onClick).not.toHaveBeenCalled();
    });

    it('shows the tooltip even when tooltipDisabled is set', () => {
      const wrapper = mount(PageAction, {
        props: { icon: 'i', label: 'Edit', disabledReason: 'Blocked', tooltipDisabled: true },
      });

      // A blocker the operator cannot read is worse than no tooltip at all.
      expect(wrapper.get('[data-tooltip]').attributes('data-tooltip-disabled')).toBe('false');
    });
  });

  it('fires the click handler when it is not blocked', () => {
    const onClick = vi.fn();
    const wrapper = mount(PageAction, {
      props: { icon: 'i', label: 'Edit', showLabel: true },
      attrs: { onClick },
    });

    wrapper.get('button').trigger('click');

    expect(onClick).toHaveBeenCalledOnce();
  });
});
