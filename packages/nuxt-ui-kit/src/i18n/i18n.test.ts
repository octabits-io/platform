import { describe, expect, it } from 'vitest';
import { kitMessagesEn } from './index.ts';

describe('kit message fragments', () => {
  it('no empty values', () => {
    for (const entries of Object.values(kitMessagesEn)) {
      for (const value of Object.values(entries)) {
        expect(value).toBeTruthy();
      }
    }
  });
});
