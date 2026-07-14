/**
 * HTTP Handler Utilities for PostgreSQL Object Storage
 *
 * Provides framework-agnostic utilities to serve objects from PostgreSQL storage
 * via HTTP endpoints. Compatible with Express, NestJS, Nuxt/Nitro, and more.
 */

import { type Result } from '../../../result/index.ts';
import type { ObjectFileServer } from '../../base/interfaces';

export interface ServeObjectParams {
  readonly namespace?: string;
  readonly key: string;
}

export interface ServeObjectResult {
  readonly found: boolean;
  readonly data?: Buffer;
  readonly contentType?: string;
  readonly size?: number;
  readonly metadata?: Record<string, string>;
  readonly etag?: string;
  readonly lastModified?: string;
}

export type ServeObjectError = {
  key: 'not_found' | 'invalid_key' | 'internal_error';
  message: string;
  statusCode: number;
};

/**
 * Options shared by all serve-handler factories.
 */
export interface ServeHandlerOptions {
  /**
   * Value for the `Content-Disposition` response header on successful
   * responses (e.g. `'attachment'`). Default: unset (browsers render inline).
   *
   * WARNING: serving user-uploaded content (SVG, HTML, ...) inline from the
   * same origin as your application enables stored XSS — the document's
   * scripts run with your origin's privileges. Set `'attachment'` (or serve
   * blobs from a separate, sandboxed origin) whenever stored objects are not
   * fully trusted.
   */
  readonly contentDisposition?: string;
}

/**
 * Request keys are untrusted. Reject keys that fail `isValidObjectKey`
 * (traversal segments, leading slash, empty), both in their raw form and —
 * when the raw form is valid percent-encoding — in their decoded form, so an
 * encoded `%2e%2e/` cannot slip past frameworks that hand us the raw path.
 * The raw key is what gets looked up; decoding is for validation only.
 */
function isRequestKeySafe(key: string): boolean {
  if (!isValidObjectKey(key)) return false;
  try {
    const decoded = decodeURIComponent(key);
    if (decoded !== key && !isValidObjectKey(decoded)) return false;
  } catch {
    // Not valid percent-encoding — it cannot hide an encoded traversal.
  }
  return true;
}

/**
 * Core function to retrieve object data using ObjectFileServer.
 * Validates the key (traversal, leading slash, encoded variants) before any
 * storage access; invalid keys yield an `invalid_key` error with status 400.
 */
export async function getObjectData(
  fileServer: ObjectFileServer,
  params: ServeObjectParams
): Promise<Result<ServeObjectResult, ServeObjectError>> {
  if (!isRequestKeySafe(params.key)) {
    return {
      ok: false,
      error: {
        key: 'invalid_key',
        message: 'Invalid object key',
        statusCode: 400,
      },
    };
  }

  const result = await fileServer.getObjectData({ namespace: params.namespace, key: params.key });

  if (!result.ok) {
    const statusCode = result.error.key === 'not_found' ? 404 : 500;
    return {
      ok: false,
      error: {
        key: result.error.key === 'not_found' ? 'not_found' : 'internal_error',
        message: result.error.message,
        statusCode,
      },
    };
  }

  const obj = result.value;

  // Generate ETag from size and lastModified
  const etag = `"${Buffer.from(`${obj.size}-${obj.lastModified}`).toString('base64')}"`;

  return {
    ok: true,
    value: {
      found: true,
      data: obj.data,
      contentType: obj.contentType,
      size: obj.size,
      metadata: obj.metadata,
      etag,
      lastModified: obj.lastModified,
    },
  };
}

// ============================================================================
// FRAMEWORK-SPECIFIC HANDLERS
// ============================================================================

/**
 * Express/Connect-compatible middleware handler
 */
export interface ExpressLikeRequest {
  params: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
}

export interface ExpressLikeResponse {
  status(code: number): this;
  set(field: string, value: string): this;
  send(body: Buffer | string): this;
  end(): this;
}

export function createExpressHandler(fileServer: ObjectFileServer, namespace?: string, options?: ServeHandlerOptions) {
  return async (
    req: ExpressLikeRequest,
    res: ExpressLikeResponse
  ): Promise<void> => {
    // Content-Type reflects user-controlled upload metadata — never let
    // browsers MIME-sniff it into something executable.
    res.set('X-Content-Type-Options', 'nosniff');

    const key = req.params.key || req.params['0']; // Support catch-all routes

    if (!key) {
      res.status(400).send('Missing key parameter');
      return;
    }

    const result = await getObjectData(fileServer, { namespace, key });

    if (!result.ok) {
      res.status(result.error.statusCode).send(result.error.message);
      return;
    }

    const obj = result.value;

    // Set headers
    if (obj.contentType) {
      res.set('Content-Type', obj.contentType);
    }
    if (options?.contentDisposition) {
      res.set('Content-Disposition', options.contentDisposition);
    }
    if (obj.size !== undefined) {
      res.set('Content-Length', obj.size.toString());
    }
    if (obj.etag) {
      res.set('ETag', obj.etag);
    }
    if (obj.lastModified) {
      res.set('Last-Modified', new Date(obj.lastModified).toUTCString());
    }

    // Set cache headers (adjust as needed)
    res.set('Cache-Control', 'public, max-age=31536000, immutable');

    // Check If-None-Match for 304 responses
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch === obj.etag) {
      res.status(304).end();
      return;
    }

    // Send the data
    res.status(200).send(obj.data!);
  };
}

/**
 * Nuxt/Nitro event handler factory
 */
export interface NitroEvent {
  context: {
    params?: Record<string, string>;
  };
  node: {
    req: {
      headers: Record<string, string | string[] | undefined>;
    };
    res: {
      statusCode?: number;
      setHeader(name: string, value: string | number): void;
      end(data?: Buffer | string): void;
    };
  };
}

export function createNitroHandler(fileServer: ObjectFileServer, namespace?: string, options?: ServeHandlerOptions) {
  return async (event: NitroEvent, key?: string): Promise<Buffer | string> => {
    // Content-Type reflects user-controlled upload metadata — never let
    // browsers MIME-sniff it into something executable.
    event.node.res.setHeader('X-Content-Type-Options', 'nosniff');

    const _key = key || event.context.params?.key || event.context.params?.['0'];

    if (!_key) {
      event.node.res.statusCode = 400;
      return 'Missing key parameter';
    }

    const result = await getObjectData(fileServer, { namespace, key: _key });

    if (!result.ok) {
      event.node.res.statusCode = result.error.statusCode;
      return result.error.message;
    }

    const obj = result.value;

    // Set headers
    if (obj.contentType) {
      event.node.res.setHeader('Content-Type', obj.contentType);
    }
    if (options?.contentDisposition) {
      event.node.res.setHeader('Content-Disposition', options.contentDisposition);
    }
    if (obj.size !== undefined) {
      event.node.res.setHeader('Content-Length', obj.size);
    }
    if (obj.etag) {
      event.node.res.setHeader('ETag', obj.etag);
    }
    if (obj.lastModified) {
      event.node.res.setHeader('Last-Modified', new Date(obj.lastModified).toUTCString());
    }

    event.node.res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    // Check If-None-Match for 304 responses
    const ifNoneMatch = event.node.req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch === obj.etag) {
      event.node.res.statusCode = 304;
      event.node.res.end();
      return '';
    }

    event.node.res.statusCode = 200;
    return obj.data!;
  };
}

/**
 * Standard Web API Response factory (works with modern frameworks)
 */
export async function createWebResponse(
  fileServer: ObjectFileServer,
  params: ServeObjectParams,
  requestHeaders?: Headers,
  options?: ServeHandlerOptions
): Promise<Response> {
  const result = await getObjectData(fileServer, params);

  if (!result.ok) {
    return new Response(result.error.message, {
      status: result.error.statusCode,
      headers: {
        'Content-Type': 'text/plain',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  const obj = result.value;

  // Check If-None-Match for 304 responses
  const ifNoneMatch = requestHeaders?.get('if-none-match');
  if (ifNoneMatch && ifNoneMatch === obj.etag) {
    return new Response(null, {
      status: 304,
      headers: {
        'ETag': obj.etag!,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  const headers = new Headers();

  // Content-Type reflects user-controlled upload metadata — never let
  // browsers MIME-sniff it into something executable.
  headers.set('X-Content-Type-Options', 'nosniff');

  if (obj.contentType) {
    headers.set('Content-Type', obj.contentType);
  }
  if (options?.contentDisposition) {
    headers.set('Content-Disposition', options.contentDisposition);
  }
  if (obj.size !== undefined) {
    headers.set('Content-Length', obj.size.toString());
  }
  if (obj.etag) {
    headers.set('ETag', obj.etag);
  }
  if (obj.lastModified) {
    headers.set('Last-Modified', new Date(obj.lastModified).toUTCString());
  }

  headers.set('Cache-Control', 'public, max-age=31536000, immutable');

  // Convert Buffer to Uint8Array for Response body compatibility
  // Data is always present when getObjectData returns ok
  return new Response(new Uint8Array(obj.data!), {
    status: 200,
    headers,
  });
}

/**
 * Generic handler factory that returns a simple handler function
 * Useful for custom integrations
 */
export interface GenericRequest {
  namespace?: string;
  key: string;
  headers?: Record<string, string | undefined>;
}

export interface GenericResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

export function createGenericHandler(fileServer: ObjectFileServer, options?: ServeHandlerOptions) {
  return async (req: GenericRequest): Promise<GenericResponse> => {
    const result = await getObjectData(fileServer, {
      namespace: req.namespace,
      key: req.key,
    });

    if (!result.ok) {
      return {
        statusCode: result.error.statusCode,
        headers: {
          'Content-Type': 'text/plain',
          'X-Content-Type-Options': 'nosniff',
        },
        body: result.error.message,
      };
    }

    const obj = result.value;

    // Check If-None-Match for 304 responses
    const ifNoneMatch = req.headers?.['if-none-match'];
    if (ifNoneMatch && ifNoneMatch === obj.etag) {
      return {
        statusCode: 304,
        headers: {
          'ETag': obj.etag!,
          'X-Content-Type-Options': 'nosniff',
        },
        body: '',
      };
    }

    const headers: Record<string, string> = {
      'Cache-Control': 'public, max-age=31536000, immutable',
      // Content-Type reflects user-controlled upload metadata — never let
      // browsers MIME-sniff it into something executable.
      'X-Content-Type-Options': 'nosniff',
    };

    if (obj.contentType) {
      headers['Content-Type'] = obj.contentType;
    }
    if (options?.contentDisposition) {
      headers['Content-Disposition'] = options.contentDisposition;
    }
    if (obj.size !== undefined) {
      headers['Content-Length'] = obj.size.toString();
    }
    if (obj.etag) {
      headers['ETag'] = obj.etag;
    }
    if (obj.lastModified) {
      headers['Last-Modified'] = new Date(obj.lastModified).toUTCString();
    }

    return {
      statusCode: 200,
      headers,
      body: obj.data!,
    };
  };
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Parse key from URL path
 * Supports patterns like:
 * - /storage/:key*
 * - /api/storage/:key*
 *
 * The extracted key is percent-decoded and validated with `isValidObjectKey`;
 * keys containing traversal segments (`..`, plain or percent-encoded), a
 * leading slash, or nothing at all yield `{}` instead of a key.
 */
export function parseStoragePath(path: string): {
  key?: string;
} {
  // Remove leading slash and split
  const parts = path.replace(/^\/+/, '').split('/');

  // Remove 'storage' or 'api/storage' prefix if present
  let startIndex = 0;
  if (parts[0] === 'storage') {
    startIndex = 1;
  } else if (parts[0] === 'api' && parts[1] === 'storage') {
    startIndex = 2;
  }

  if (parts.length < startIndex + 1) {
    return {};
  }

  const rawKey = parts.slice(startIndex).join('/').replace(/\/+$/, '');

  // URL paths arrive percent-encoded: decode, then reject unsafe keys.
  let key: string;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    return {};
  }

  if (!isValidObjectKey(key)) {
    return {};
  }

  return { key };
}

/**
 * Validate object key format. Enforced automatically by `getObjectData` (and
 * therefore by every serve handler) and by `parseStoragePath`; exported for
 * callers that build their own request plumbing.
 */
export function isValidObjectKey(key: string): boolean {
  if (!key || key.length === 0) return false;
  if (key.startsWith('/') || key.endsWith('/')) return false;
  if (key.includes('..')) return false; // Prevent directory traversal
  if (key.includes('//')) return false;
  return true;
}

/**
 * Sanitize object key
 */
export function sanitizeObjectKey(key: string): string {
  return key
    .replace(/^\/+/, '') // Remove leading slashes
    .replace(/\/+$/, '') // Remove trailing slashes
    .split('/') // Split into parts
    .filter(part => part !== '..' && part !== '') // Remove .. and empty parts
    .join('/'); // Rejoin
}
