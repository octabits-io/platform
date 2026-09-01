// Mounts a kit SFC; `@nuxt/ui` and `vue-i18n` are stubbed.
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { CalendarDate } from '@internationalized/date';

/**
 * Two things about `DateRangeInput`'s calendar popovers that typechecking
 * cannot see:
 *
 * - **`visible-month`.** `blockedDates` is a prop, so the parent can only have
 *   fetched a finite window, while the calendar pages anywhere. Past the
 *   fetched edge a blocked day renders as free — the one wrong answer this
 *   input can give — so the month on screen has to reach the parent.
 * - **Past days are dimmed, never disabled.** Recording a stay that already
 *   happened is ordinary work; only picking one by accident is not.
 */

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    te: () => true,
    locale: ref('en'),
  }),
}));

vi.mock('@nuxt/ui/components/Popover.vue', () => ({
  default: defineComponent({
    name: 'UPopoverStub',
    props: { open: Boolean },
    emits: ['update:open'],
    setup(_props, { slots }) {
      return () => h('div', { class: 'popover' }, [slots.default?.(), slots.content?.()]);
    },
  }),
}));

/** Renders one cell per day in `WINDOW`, so the `#day` slot's classes are assertable. */
const WINDOW = [
  new CalendarDate(2026, 8, 30),
  new CalendarDate(2026, 8, 31),
  new CalendarDate(2026, 9, 1),
  new CalendarDate(2026, 9, 2),
  new CalendarDate(2026, 9, 3),
];

vi.mock('@nuxt/ui/components/Calendar.vue', () => ({
  default: defineComponent({
    name: 'UCalendarStub',
    props: { modelValue: Object, placeholder: Object, isDateDisabled: Function, ui: Object },
    emits: ['update:modelValue', 'update:placeholder'],
    setup(props, { slots }) {
      return () =>
        h(
          'div',
          { class: 'calendar' },
          WINDOW.map((day) =>
            h(
              'span',
              {
                class: 'cell',
                'data-iso': day.toString(),
                'data-disabled': props.isDateDisabled?.(day) ? 'true' : undefined,
              },
              slots.day?.({ day }),
            ),
          ),
        );
    },
  }),
}));

vi.mock('@nuxt/ui/components/InputDate.vue', () => ({
  default: defineComponent({
    name: 'UInputDateStub',
    props: { modelValue: Object, isDateDisabled: Function, size: String, disabled: Boolean },
    emits: ['update:modelValue'],
    setup(_props, { slots }) {
      return () => h('div', { class: 'input-date' }, slots.trailing?.());
    },
  }),
}));

vi.mock('@nuxt/ui/components/Button.vue', () => ({
  default: defineComponent({
    name: 'UButtonStub',
    inheritAttrs: false,
    props: { icon: String, disabled: Boolean },
    setup(props, { attrs }) {
      return () => h('button', { ...attrs, 'data-icon': props.icon });
    },
  }),
}));

vi.mock('@nuxt/ui/components/Icon.vue', () => ({
  default: defineComponent({
    name: 'UIconStub',
    props: { name: String },
    setup: (props) => () => h('i', { 'data-icon': props.name }),
  }),
}));

import DateRangeInput from './DateRangeInput.vue';

type Wrapper = ReturnType<typeof mount>;

const popovers = (wrapper: Wrapper) => wrapper.findAllComponents({ name: 'UPopoverStub' });
const calendars = (wrapper: Wrapper) => wrapper.findAllComponents({ name: 'UCalendarStub' });
const cell = (wrapper: Wrapper, iso: string) =>
  wrapper.findAll('.cell').find((c) => c.attributes('data-iso') === iso)!;

/** Opens the start (0) or end (1) popover the way the trigger would. */
async function openPopover(wrapper: Wrapper, index: 0 | 1) {
  await popovers(wrapper)[index]!.vm.$emit('update:open', true);
}

describe('DateRangeInput', () => {
  beforeEach(() => {
    // `todayIso` is captured at setup; pin the clock before every mount.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-01T09:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('visible-month', () => {
    it('announces the opening month — the calendar opens before it navigates', async () => {
      const wrapper = mount(DateRangeInput, {
        props: { modelValue: { start: '2027-07-20', end: '2027-07-26' } },
      });

      await openPopover(wrapper, 0);

      expect(wrapper.emitted('visible-month')).toEqual([['2027-07-01']]);
    });

    it('falls back to the other endpoint, then to today, for an empty side', async () => {
      const halfSet = mount(DateRangeInput, {
        props: { modelValue: { start: '', end: '2027-07-26' }, kind: 'booking' },
      });
      await openPopover(halfSet, 0);
      expect(halfSet.emitted('visible-month')).toEqual([['2027-07-01']]);

      const empty = mount(DateRangeInput, { props: { modelValue: { start: '', end: '' } } });
      await openPopover(empty, 0);
      expect(empty.emitted('visible-month')).toEqual([['2026-09-01']]);
    });

    it('reports every month the operator pages to', async () => {
      const wrapper = mount(DateRangeInput, { props: { modelValue: { start: '', end: '' } } });

      await calendars(wrapper)[0]!.vm.$emit('update:placeholder', new CalendarDate(2027, 7, 15));
      await calendars(wrapper)[1]!.vm.$emit('update:placeholder', new CalendarDate(2027, 8, 4));

      expect(wrapper.emitted('visible-month')).toEqual([['2027-07-01'], ['2027-08-01']]);
    });
  });

  describe('past days', () => {
    it('dims them without disabling them — a past stay is still recordable', async () => {
      const wrapper = mount(DateRangeInput, { props: { modelValue: { start: '', end: '' } } });
      await openPopover(wrapper, 0);

      expect(cell(wrapper, '2026-08-31').find('span').classes()).toContain('text-dimmed');
      expect(cell(wrapper, '2026-08-31').attributes('data-disabled')).toBeUndefined();
      // Today and later stay plain.
      expect(cell(wrapper, '2026-09-01').find('span').classes()).not.toContain('text-dimmed');
      expect(cell(wrapper, '2026-09-02').find('span').classes()).not.toContain('text-dimmed');
    });

    it('leaves a blocked day its own (louder) styling', async () => {
      const wrapper = mount(DateRangeInput, {
        props: { modelValue: { start: '', end: '' }, blockedDates: ['2026-08-31'] },
      });
      await openPopover(wrapper, 0);

      expect(cell(wrapper, '2026-08-31').attributes('data-disabled')).toBe('true');
      expect(cell(wrapper, '2026-08-31').find('span').classes()).not.toContain('text-dimmed');
    });

    it('states a period that is over, and stays quiet about one still running', () => {
      const over = mount(DateRangeInput, {
        props: { modelValue: { start: '2026-08-20', end: '2026-08-27' } },
      });
      expect(over.text()).toContain('dateRange.pastPeriod');

      const ongoing = mount(DateRangeInput, {
        props: { modelValue: { start: '2026-08-28', end: '2026-09-04' } },
      });
      expect(ongoing.text()).not.toContain('dateRange.pastPeriod');
    });
  });
});
