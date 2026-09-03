// Mounts a kit SFC; `@nuxt/ui` and `vue-i18n` are stubbed.
// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import {
  buildProposal,
  entityAnchor,
  pendingAnchor,
  proposeCreate,
  proposeFields,
} from '@octabits-io/framework/proposal';
import type { Proposal, ProposalDecision } from '@octabits-io/framework/proposal';

/**
 * `ProposalReviewCard` is the generic review surface: it must render every
 * operation kind the contract can carry, default to accepting, and emit a
 * decision that reflects what the reviewer actually kept and edited. Those
 * are DOM facts — a review that silently drops the creates, or an apply that
 * ignores an unchecked row, typechecks fine and is wrong.
 *
 * The `@nuxt/ui` primitives are stubbed to plain elements; what is under test
 * is what the kit passes them and what it does with what comes back.
 */
vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown> | number) =>
      params && typeof params === 'object' ? `${key}:${JSON.stringify(params)}` : key,
    te: () => false,
    locale: ref('en'),
  }),
}));

// Mock factories are hoisted above the imports, so anything they share has to
// be hoisted with them.
const { slotWrapper, textControl } = await vi.hoisted(async () => {
  const { defineComponent, h } = await import('vue');
  return {
    slotWrapper: (name: string, tag = 'div') =>
      defineComponent({
        name,
        inheritAttrs: false,
        setup(_props, { slots, attrs }) {
          return () =>
            h(tag, { ...attrs, 'data-stub': name }, [
              slots.header?.(),
              slots.default?.(),
              slots.footer?.(),
            ]);
        },
      }),
    textControl: (name: string, tag: 'input' | 'textarea') =>
      defineComponent({
        name,
        props: { modelValue: String, disabled: Boolean, maxlength: Number },
        emits: ['update:modelValue'],
        setup(props, { emit }) {
          return () =>
            h(tag, {
              'data-stub': name,
              value: props.modelValue,
              disabled: props.disabled || undefined,
              onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value),
            });
        },
      }),
  };
});

vi.mock('@nuxt/ui/components/Card.vue', () => ({ default: slotWrapper('UCard') }));
vi.mock('@nuxt/ui/components/Badge.vue', () => ({ default: slotWrapper('UBadge', 'span') }));
vi.mock('@nuxt/ui/components/Icon.vue', () => ({
  default: defineComponent({ name: 'UIcon', setup: () => () => h('span') }),
}));
vi.mock('@nuxt/ui/components/Tabs.vue', () => ({
  default: defineComponent({
    name: 'UTabs',
    props: { items: Array, modelValue: String },
    emits: ['update:modelValue'],
    setup(props, { emit }) {
      return () =>
        h(
          'div',
          { 'data-stub': 'UTabs' },
          (props.items as Array<{ label: string; value: string }>).map((item) =>
            h(
              'button',
              { 'data-tab': item.value, onClick: () => emit('update:modelValue', item.value) },
              item.label,
            ),
          ),
        );
    },
  }),
}));
vi.mock('@nuxt/ui/components/Alert.vue', () => ({
  default: defineComponent({
    name: 'UAlert',
    props: { description: String },
    setup: (props) => () => h('div', { 'data-stub': 'UAlert' }, props.description),
  }),
}));
vi.mock('@nuxt/ui/components/Checkbox.vue', () => ({
  default: defineComponent({
    name: 'UCheckbox',
    props: { modelValue: Boolean },
    emits: ['update:modelValue'],
    setup(props, { emit }) {
      return () =>
        h('input', {
          type: 'checkbox',
          checked: props.modelValue,
          onChange: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).checked),
        });
    },
  }),
}));
vi.mock('@nuxt/ui/components/Input.vue', () => ({ default: textControl('UInput', 'input') }));
vi.mock('@nuxt/ui/components/Textarea.vue', () => ({ default: textControl('UTextarea', 'textarea') }));
vi.mock('@nuxt/ui/components/Button.vue', () => ({
  default: defineComponent({
    name: 'UButton',
    props: { label: String, disabled: Boolean, loading: Boolean },
    setup(props, { attrs }) {
      return () => h('button', { ...attrs, disabled: props.disabled || undefined }, props.label);
    },
  }),
}));

import ProposalReviewCard from './ProposalReviewCard.vue';

const listing = entityAnchor('listing', 88);

function fieldProposal(): Proposal {
  return buildProposal({
    scope: 'listing:88',
    operations: proposeFields({
      target: listing,
      current: { title: 'Ferienwohnung Seeblick 3', excerpt: null },
      proposed: { title: 'Seeblick 3 — Balkon über dem Kochelsee', excerpt: 'Zwei Zimmer, Südbalkon.' },
      display: { title: { control: 'text', label: 'Title' }, excerpt: { control: 'multiline', label: 'Excerpt' } },
    }),
    provenance: { model: 'claude-sonnet-4-6', keySource: 'tenant', costMicros: 18_420 },
  });
}

describe('ProposalReviewCard', () => {
  it('renders every operation kind, not only updates', () => {
    const proposal = buildProposal({
      scope: 'place:root',
      operations: [
        ...proposeFields({ target: listing, current: { title: 'A' }, proposed: { title: 'B' } }),
        proposeCreate({ collection: 'places', ref: 'region', value: { name: 'Oberbayern' } }),
        {
          id: 'del-1',
          op: 'delete',
          target: entityAnchor('place', 7, 'Old district'),
          current: { name: 'Old district' },
        },
        { id: 'ord-1', op: 'reorder', collection: 'sections', current: ['a', 'b'], proposed: ['b', 'a'] },
      ],
    });
    const wrapper = mount(ProposalReviewCard, { props: { proposal } });

    const text = wrapper.text();
    expect(text).toContain('ai.review.willUpdate');
    expect(text).toContain('ai.review.willCreate');
    expect(text).toContain('ai.review.willDelete');
    expect(text).toContain('ai.review.willReorder');
    expect(text).toContain('Old district');
    expect(text).toContain('b → a');
    expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(4);
  });

  it('defaults to accepting everything and shows what each update replaces', () => {
    const wrapper = mount(ProposalReviewCard, { props: { proposal: fieldProposal() } });

    expect(wrapper.text()).toContain('2 / 2');
    expect(wrapper.text()).toContain('Ferienwohnung Seeblick 3');
    // An empty `current` is said out loud rather than rendered as nothing.
    expect(wrapper.text()).toContain('ai.review.currentEmpty');
    // Provenance is part of the review, not a footnote.
    expect(wrapper.text()).toContain('claude-sonnet-4-6');
    expect(wrapper.text()).toContain('0.0184 USD');
  });

  it('emits a decision carrying only the kept operations, with edits', async () => {
    const wrapper = mount(ProposalReviewCard, { props: { proposal: fieldProposal() } });
    const [title, excerpt] = fieldProposal().operations.map((op) => op.id);

    // Reject the excerpt, edit the title.
    const boxes = wrapper.findAll('input[type="checkbox"]');
    await boxes[1]!.setValue(false);
    expect(wrapper.text()).toContain('1 / 2');
    expect(wrapper.get('[data-stub="UTextarea"]').attributes('disabled')).toBeDefined();

    await wrapper.get('[data-stub="UInput"]').setValue('Seeblick 3 am See');
    await wrapper.findAll('button').at(-1)!.trigger('click');

    const decision = wrapper.emitted<[ProposalDecision]>('apply')?.[0]?.[0];
    expect(decision?.accepted).toEqual([title]);
    expect(decision?.edits).toEqual([{ id: title, value: 'Seeblick 3 am See' }]);
    expect(decision?.accepted).not.toContain(excerpt);
  });

  it('warns when a kept child depends on a rejected parent', async () => {
    const proposal = buildProposal({
      scope: 'place:root',
      operations: [
        proposeCreate({ collection: 'places', ref: 'region', value: { name: 'Oberbayern' } }),
        proposeCreate({
          collection: 'places',
          ref: 'town',
          value: { name: 'Kochel' },
          parent: pendingAnchor('region'),
        }),
      ],
    });
    const wrapper = mount(ProposalReviewCard, { props: { proposal } });
    expect(wrapper.find('[data-stub="UAlert"]').exists()).toBe(false);

    await wrapper.findAll('input[type="checkbox"]')[0]!.setValue(false);

    expect(wrapper.get('[data-stub="UAlert"]').text()).toContain('ai.review.dangling');
  });

  it('exposes locale variants as tabs and filters operations by the active one', async () => {
    const proposal = buildProposal({
      scope: 'listing:88',
      operations: [
        ...proposeFields({ target: listing, variant: 'de', current: { title: 'A' }, proposed: { title: 'B' } }),
        ...proposeFields({ target: listing, variant: 'en', current: { title: 'C' }, proposed: { title: 'D' } }),
      ],
    });
    const wrapper = mount(ProposalReviewCard, { props: { proposal, variantLabel: (v: string) => v.toUpperCase() } });

    expect(wrapper.get('[data-tab="de"]').text()).toBe('DE');
    expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(1);
    expect(wrapper.text()).toContain('A');

    await wrapper.get('[data-tab="en"]').trigger('click');
    expect(wrapper.text()).toContain('C');
    expect(wrapper.text()).not.toContain('Current:A');
  });
});
