import { ref, computed, watch } from 'vue';

/**
 * Offset-based table pagination: `page`/`itemsPerPage`/`total` state with a
 * derived `offset` and ready-to-spread `queryParams { limit, offset }`.
 * `onPaginationChange` fires whenever page or page size changes (refetch hook).
 */
export function usePagination(options: {
  defaultLimit?: number;
  onPaginationChange?: () => void;
} = {}) {
  const { defaultLimit = 50, onPaginationChange } = options;

  const page = ref(1);
  const itemsPerPage = ref(defaultLimit);
  const total = ref(0);

  const offset = computed(() => (page.value - 1) * itemsPerPage.value);

  const queryParams = computed(() => ({
    limit: itemsPerPage.value,
    offset: offset.value,
  }));

  function setTotal(value: number) {
    total.value = value;
  }

  function resetPagination() {
    page.value = 1;
  }

  watch([page, itemsPerPage], () => {
    onPaginationChange?.();
  });

  return {
    page,
    itemsPerPage,
    total,
    offset,
    queryParams,
    setTotal,
    resetPagination,
  };
}
