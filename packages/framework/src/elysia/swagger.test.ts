import { describe, it, expect } from 'vitest';
import { buildSwaggerOptions } from './swagger';

describe('buildSwaggerOptions', () => {
  it('builds the full options shape', () => {
    expect(buildSwaggerOptions({
      title: 'Operator API',
      version: '1.2.0',
      description: 'API for the operator panel',
      tags: [
        { name: 'System', description: 'System endpoints' },
        { name: 'Auth', description: 'Authentication endpoints' },
      ],
      path: '/docs',
      exclude: ['/auth/*', '/debug/*'],
    })).toEqual({
      documentation: {
        info: {
          title: 'Operator API',
          version: '1.2.0',
          description: 'API for the operator panel',
        },
        tags: [
          { name: 'System', description: 'System endpoints' },
          { name: 'Auth', description: 'Authentication endpoints' },
        ],
      },
      path: '/docs',
      exclude: ['/auth/*', '/debug/*'],
    });
  });

  it('defaults path to /swagger and omits unset optionals entirely', () => {
    const options = buildSwaggerOptions({ title: 'Minimal API', version: '0.1.0' });

    expect(options).toEqual({
      documentation: { info: { title: 'Minimal API', version: '0.1.0' } },
      path: '/swagger',
    });
    // Omitted, not present-and-undefined — the object stays a minimal literal.
    expect('description' in options.documentation.info).toBe(false);
    expect('tags' in options.documentation).toBe(false);
    expect('exclude' in options).toBe(false);
  });
});
