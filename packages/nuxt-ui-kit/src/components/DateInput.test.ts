// Mounts a kit SFC; `@nuxt/ui` and `vue-i18n` are stubbed.
// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';

/**
 * `DateInput`'s clear button: the feature that gives an optional date field a
 * way back to "no date" (a calendar can only ever pick). Two things about it
 * are DOM-level and therefore invisible to typechecking — the × only exists
 * once a date is set, and its click must not bubble into the popover trigger it
 * sits inside, or clearing immediately reopens the calendar.
 */
vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    te: (key: string) => key === 'dateInput.clear',
    locale: ref('en'),
  }),
}));

vi.mock('@nuxt/ui/components/Popover.vue', () => ({
  default: defineComponent({
    name: 'UPopoverStub',
    props: { open: Boolean },
    emits: ['update:open'],
    setup(_props, { slots }) {
      return () => h('div', { class: 'popover' }, slots.default?.());
    },
  }),
}));

vi.mock('@nuxt/ui/components/Calendar.vue', () => ({
  default: defineComponent({ name: 'UCalendarStub', setup: () => () => h('div', 'calendar') }),
}));

vi.mock('@nuxt/ui/components/Button.vue', () => ({
  default: defineComponent({
    name: 'UButtonStub',
    inheritAttrs: false,
    props: { icon: String, size: String, disabled: Boolean, variant: String, color: String },
    setup(props, { attrs, slots }) {
      return () =>
        h(
          'button',
          {
            ...attrs,
            'data-icon': props.icon,
            'data-size': props.size,
            disabled: props.disabled || undefined,
          },
          slots.default?.(),
        );
    },
  }),
}));

import DateInput from './DateInput.vue';

const buttons = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('button');
const clearButton = (wrapper: ReturnType<typeof mount>) =>
  wrapper.findAll('button').find((b) => b.attributes('data-icon') === 'i-lucide-x');

describe('DateInput', () => {
  it('shows the placeholder while empty and the formatted date once set', () => {
    const empty = mount(DateInput, { props: { modelValue: '', placeholder: 'Created on' } });
    expect(empty.text()).toContain('Created on');

    const set = mount(DateInput, { props: { modelValue: '2026-08-31' } });
    expect(set.text()).not.toBe('');
    expect(set.text()).not.toContain('Created on');
  });

  it('ignores a value that is not an ISO date rather than rendering "Invalid Date"', () => {
    const wrapper = mount(DateInput, { props: { modelValue: 'not-a-date', placeholder: 'Pick' } });

    expect(wrapper.text()).toContain('Pick');
  });

  it('forwards size to the trigger', () => {
    const wrapper = mount(DateInput, { props: { modelValue: '', size: 'sm' } });

    expect(buttons(wrapper)[0]!.attributes('data-size')).toBe('sm');
  });

  describe('clearable', () => {
    it('is off by default — a required field keeps exactly one control', () => {
      const wrapper = mount(DateInput, { props: { modelValue: '2026-08-31' } });

      expect(clearButton(wrapper)).toBeUndefined();
    });

    it('appears only once a date is set', () => {
      const empty = mount(DateInput, { props: { modelValue: '', clearable: true } });
      expect(clearButton(empty)).toBeUndefined();

      const set = mount(DateInput, { props: { modelValue: '2026-08-31', clearable: true } });
      expect(clearButton(set)).toBeDefined();
    });

    it('emits an empty string and stops the click from reaching the trigger', async () => {
      const wrapper = mount(DateInput, { props: { modelValue: '2026-08-31', clearable: true } });
      const onPopoverClick = vi.fn();
      wrapper.get('.popover').element.addEventListener('click', onPopoverClick);

      await clearButton(wrapper)!.trigger('click');

      expect(wrapper.emitted('update:modelValue')).toEqual([['']]);
      // Without stopPropagation the click opens the calendar it just cleared.
      expect(onPopoverClick).not.toHaveBeenCalled();
    });

    it('labels the clear button from i18n, matching the trigger size', () => {
      const wrapper = mount(DateInput, {
        props: { modelValue: '2026-08-31', clearable: true, size: 'xs' },
      });

      expect(clearButton(wrapper)!.attributes('aria-label')).toBe('dateInput.clear');
      expect(clearButton(wrapper)!.attributes('data-size')).toBe('xs');
    });

    it('disables both controls when the input is disabled', () => {
      const wrapper = mount(DateInput, {
        props: { modelValue: '2026-08-31', clearable: true, disabled: true },
      });

      for (const button of buttons(wrapper)) {
        expect(button.attributes('disabled')).toBeDefined();
      }
    });
  });
});
