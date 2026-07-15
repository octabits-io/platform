import { describe, expect, it } from 'vitest';
import { kitMessagesDe, kitMessagesDeFormal, kitMessagesEn } from './index.ts';

const flatKeys = (messages: object): string[] =>
  Object.entries(messages).flatMap(([group, entries]) =>
    Object.keys(entries as object).map((key) => `${group}.${key}`),
  );

describe('kit message fragments', () => {
  it('all locales cover the same keys', () => {
    const en = flatKeys(kitMessagesEn);
    expect(flatKeys(kitMessagesDe)).toEqual(en);
    expect(flatKeys(kitMessagesDeFormal)).toEqual(en);
  });

  it('no empty values', () => {
    for (const messages of [kitMessagesEn, kitMessagesDe, kitMessagesDeFormal]) {
      for (const entries of Object.values(messages)) {
        for (const value of Object.values(entries)) {
          expect(value).toBeTruthy();
        }
      }
    }
  });

  it('the formal register addresses the reader as Sie', () => {
    expect(kitMessagesDeFormal.errors.service_unavailable).toContain('Sie');
    expect(kitMessagesDeFormal.auth.sessionExpiredDescription).toContain('Ihre');
    expect(kitMessagesDe.errors.service_unavailable).not.toContain('Sie');
  });
});
