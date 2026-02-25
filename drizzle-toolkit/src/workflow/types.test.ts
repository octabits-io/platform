import { describe, it, expect } from 'vitest';
import { createStepHandlerRegistry, type StepHandler } from './types.ts';

const noopHandler: StepHandler = async () => ({ ok: true, value: {} });

describe('createStepHandlerRegistry', () => {
  it('starts empty', () => {
    const registry = createStepHandlerRegistry();
    expect(registry.types()).toEqual([]);
  });

  it('registers a handler and retrieves it', () => {
    const registry = createStepHandlerRegistry();
    registry.register('my-step', noopHandler);

    expect(registry.has('my-step')).toBe(true);
    expect(registry.get('my-step')).toBe(noopHandler);
  });

  it('returns undefined for unregistered type', () => {
    const registry = createStepHandlerRegistry();
    expect(registry.get('missing')).toBeUndefined();
  });

  it('has() returns false for unregistered type', () => {
    const registry = createStepHandlerRegistry();
    expect(registry.has('missing')).toBe(false);
  });

  it('lists all registered types', () => {
    const registry = createStepHandlerRegistry();
    registry.register('step-a', noopHandler);
    registry.register('step-b', noopHandler);
    registry.register('step-c', noopHandler);

    expect(registry.types()).toEqual(['step-a', 'step-b', 'step-c']);
  });

  it('overwrites handler when registering same type twice', () => {
    const registry = createStepHandlerRegistry();
    const handler1: StepHandler = async () => ({ ok: true, value: { v: 1 } });
    const handler2: StepHandler = async () => ({ ok: true, value: { v: 2 } });

    registry.register('step', handler1);
    registry.register('step', handler2);

    expect(registry.get('step')).toBe(handler2);
    expect(registry.types()).toEqual(['step']);
  });
});
