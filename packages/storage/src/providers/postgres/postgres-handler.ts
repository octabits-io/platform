/**
 * HTTP Handler Utilities for PostgreSQL Object Storage
 *
 * Provides framework-agnostic utilities to serve objects from PostgreSQL storage
 * via HTTP endpoints. Compatible with Express, NestJS, Nuxt/Nitro, and more.
 */

import { type Result } from '@octabits-io/foundation/result';
import type { ObjectFileServer } from '../../base/interfaces';

export interface ServeObjectParams {
  readonly tenant: string;
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
  key: 'not_found' | 'internal_error';
  message: string;
  statusCode: number;
};

/**
 * Core function to retrieve object data using ObjectFileServer
 */
export async function getObjectData(
  fileServer: ObjectFileServer,
  params: ServeObjectParams
): Promise<Result<ServeObjectResult, ServeObjectError>> {
  const result = await fileServer.getObjectData({ tenant: params.tenant, key: params.key });

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

export function createExpressHandler(fileServer: ObjectFileServer, tenant: string) {
  return async (
    req: ExpressLikeRequest,
    res: ExpressLikeResponse
  ): Promise<void> => {
    const key = req.params.key || req.params['0']; // Support catch-all routes

    if (!key) {
      res.status(400).send('Missing key parameter');
      return;
    }

    const result = await getObjectData(fileServer, { tenant, key });

    if (!result.ok) {
      res.status(result.error.statusCode).send(result.error.message);
      return;
    }

    const obj = result.value;

    // Set headers
    if (obj.contentType) {
      res.set('Content-Type', obj.contentType);
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

export function createNitroHandler(fileServer: ObjectFileServer, tenant: string) {
  return async (event: NitroEvent, key?: string): Promise<Buffer | string> => {
    const _key = key || event.context.params?.key || event.context.params?.['0'];

    if (!_key) {
      event.node.res.statusCode = 400;
      return 'Missing key parameter';
    }

    const result = await getObjectData(fileServer, { tenant, key: _key });

    if (!result.ok) {
      event.node.res.statusCode = result.error.statusCode;
      return result.error.message;
    }

    const obj = result.value;

    // Set headers
    if (obj.contentType) {
      event.node.res.setHeader('Content-Type', obj.contentType);
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
  requestHeaders?: Headers
): Promise<Response> {
  const result = await getObjectData(fileServer, params);

  if (!result.ok) {
    return new Response(result.error.message, {
      status: result.error.statusCode,
      headers: {
        'Content-Type': 'text/plain',
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
      },
    });
  }

  const headers = new Headers();

  if (obj.contentType) {
    headers.set('Content-Type', obj.contentType);
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
  tenant: string;
  key: string;
  headers?: Record<string, string | undefined>;
}

export interface GenericResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

export function createGenericHandler(fileServer: ObjectFileServer) {
  return async (req: GenericRequest): Promise<GenericResponse> => {
    const result = await getObjectData(fileServer, {
      tenant: req.tenant,
      key: req.key,
    });

    if (!result.ok) {
      return {
        statusCode: result.error.statusCode,
        headers: {
          'Content-Type': 'text/plain',
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
        },
        body: '',
      };
    }

    const headers: Record<string, string> = {
      'Cache-Control': 'public, max-age=31536000, immutable',
    };

    if (obj.contentType) {
      headers['Content-Type'] = obj.contentType;
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

  const key = parts.slice(startIndex).join('/').replace(/\/+$/, '');

  return { key };
}

/**
 * Validate object key format
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
