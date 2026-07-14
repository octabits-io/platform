import { describe, expect, it } from 'vitest';
import { useConfirm, useConfirmState } from './useConfirm.ts';

describe('useConfirm', () => {
  it('opens the dialog with the given options and resolves true on confirm', async () => {
    const { confirm } = useConfirm();
    const state = useConfirmState();

    const pending = confirm({ title: 'Delete?', dangerous: true });
    expect(state.isOpen.value).toBe(true);
    expect(state.options.value).toEqual({ title: 'Delete?', dangerous: true });

    state.handleConfirm();
    expect(state.isOpen.value).toBe(false);
    await expect(pending).resolves.toBe(true);
  });

  it('resolves false on cancel', async () => {
    const { confirm } = useConfirm();
    const state = useConfirmState();

    const pending = confirm({ title: 'Sure?' });
    state.handleCancel();
    await expect(pending).resolves.toBe(false);
  });

  it('shares one singleton state across composable instances', () => {
    const { confirm } = useConfirm();
    const stateA = useConfirmState();
    const stateB = useConfirmState();

    void confirm({ title: 'One dialog' });
    expect(stateA.isOpen.value).toBe(true);
    expect(stateB.isOpen.value).toBe(true);
    stateB.handleCancel();
    expect(stateA.isOpen.value).toBe(false);
  });
});
