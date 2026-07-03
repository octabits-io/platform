export interface DateProvider {
  now(): Date;
}

export const createDateProvider = (): DateProvider => {
  return {
    now: () => new Date(),
  };
};
