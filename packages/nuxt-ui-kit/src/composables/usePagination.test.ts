import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { usePagination } from './usePagination.ts';

describe('usePagination', () => {
  it('derives offset and queryParams from page and page size', () => {
    const p = usePagination({ defaultLimit: 20 });
    expect(p.queryParams.value).toEqual({ limit: 20, offset: 0 });
    p.page.value = 3;
    expect(p.offset.value).toBe(40);
    expect(p.queryParams.value).toEqual({ limit: 20, offset: 40 });
  });

  it('fires onPaginationChange when page or page size changes', async () => {
    const onPaginationChange = vi.fn();
    const p = usePagination({ onPaginationChange });
    p.page.value = 2;
    await nextTick();
    p.itemsPerPage.value = 10;
    await nextTick();
    expect(onPaginationChange).toHaveBeenCalledTimes(2);
  });

  it('resetPagination returns to page 1; setTotal stores the total', () => {
    const p = usePagination();
    p.page.value = 5;
    p.setTotal(123);
    p.resetPagination();
    expect(p.page.value).toBe(1);
    expect(p.total.value).toBe(123);
  });
});
