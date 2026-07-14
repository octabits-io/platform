/**
 * @octabits-io/framework/drizzle/config — a generic **config store** over any
 * Drizzle Postgres key/value table (spread `scopedConfigColumns` from
 * `../scope` to build one).
 *
 * The mechanism is the classic validate → encrypt → cache → default engine:
 *
 *   - **write** — each `{ key, value }` is validated through a caller-supplied
 *     schema; keys flagged for encryption are JSON-serialised, passed through
 *     an injected `cipher`, and stored in a `{ __encrypted: <base64> }`
 *     envelope; every entry is upserted in one statement.
 *   - **read** — rows are decrypted (envelope handling lives here), re-validated
 *     through the schema so **Zod defaults are applied for absent values**, and
 *     cached. A **present** row that fails validation follows the configurable
 *     {@link InvalidStoredValuePolicy} (default: apply the schema default; opt
 *     into `'skip'` to leave the key absent). Cacheable keys are additionally
 *     promoted into an optional cross-scope cache.
 *
 * The engine speaks **no tenant vocabulary**. Scoping is **optional**, mirroring
 * `../crud`'s base-vs-scoped split:
 *
 *   - **scoped** — pass a `{ column, value }` scope (like `../crud`'s
 *     `CrudScope`). Every read is filtered by `eq(table[column], value)`, every
 *     upsert stamps it, and the upsert conflict target is `(scopeColumn, key)`.
 *   - **unscoped** — omit `scope`. No scope filter is applied, nothing is
 *     stamped, and the conflict target is `(key)` alone — suited to a
 *     single-tenant table whose primary key is just `key`.
 *
 * ## Seams
 *
 * Every external dependency is a **structural** interface so instances from a
 * different `drizzle-orm` copy (or a hand-rolled cipher/cache/logger)
 * interoperate:
 *
 *   - {@link ConfigDatabase} — the `select`/`insert` subset used
 *   - {@link ConfigSchema}   — a `{ key, value }` validator (a Zod
 *                              discriminated-union schema satisfies it)
 *   - {@link ConfigCipher}   — injected raw-string encrypt/decrypt (this module
 *                              must NOT import `./pii` — the cipher is a seam)
 *   - {@link ScopedConfigCache} — optional cross-scope cache (build one from a
 *                              foundation `LruCache` via {@link createScopedConfigCache})
 *   - {@link ScopedConfigLogger} — optional structured logger (defaults to noop)
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { type OctError, type Result, ok, err } from '../../result/index.ts';

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * The `{ column, value }` pair a **scoped** config-service instance is bound to.
 * Every query is ANDed with `eq(table[column], value)` and every upsert stamps
 * it, so scope isolation holds by construction. `column` is the **TypeScript
 * property name** on the Drizzle table (e.g. `'tenantId'`, `'workspaceId'`),
 * not the SQL column name — mirroring `../crud`'s `CrudScope`. Omit the scope
 * entirely for an unscoped (single-tenant) config store.
 */
export interface ConfigScope<TScopeKey extends string = string> {
  column: TScopeKey;
  value: string;
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * Minimal structural view of an (augmented) Drizzle database — only the
 * `select`/`insert` builders this service uses. Satisfied by any
 * `AppDatabase<TSchema>` from `../factory` and by transaction contexts. Kept
 * structural so instances from different drizzle copies interoperate.
 */
export interface ConfigDatabase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(fields: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert(table: any): any;
}

/**
 * Result of validating one `{ key, value }` entry. Structurally satisfied by
 * Zod's `safeParse` return (extra fields like `data.key` and a richer `error`
 * are ignored) — pass a `z.discriminatedUnion('key', […])` directly.
 */
export type ConfigParseResult<TValue> =
  | { success: true; data: { value: TValue } }
  | { success: false; error: { message: string } };

/**
 * Caller-supplied config schema seam. `safeParse` validates a `{ key, value }`
 * pair and, crucially, **applies per-key defaults** (a Zod `.default(...)` on
 * the value) so a missing row still yields the configured default on read.
 */
export interface ConfigSchema<TConfigMap extends Record<string, unknown>> {
  safeParse(input: { key: string; value: unknown }): ConfigParseResult<TConfigMap[keyof TConfigMap]>;
}

/**
 * Raw-string encryption seam. The engine owns the `{ __encrypted }` envelope
 * and the JSON (de)serialisation: `encrypt` receives a plaintext string and
 * must return its ciphertext **base64-encoded**; `decrypt` receives that same
 * base64 string and must return the original plaintext. Kept a structural
 * callback so this module never imports `@octabits-io/framework/pii`.
 */
export interface ConfigCipher<E extends OctError = OctError> {
  encrypt(plaintext: string): Promise<Result<string, E>>;
  decrypt(base64Ciphertext: string): Promise<Result<string, E>>;
}

/**
 * Optional cross-scope cache seam. Only cacheable keys are ever stored (the
 * engine gates reads; a cache built via {@link createScopedConfigCache} also
 * gates writes). `invalidate` clears every cacheable key for one scope.
 */
export interface ScopedConfigCache<TConfigMap extends Record<string, unknown>> {
  get<K extends keyof TConfigMap>(scopeValue: string, key: K): TConfigMap[K] | undefined;
  set<K extends keyof TConfigMap>(scopeValue: string, key: K, value: TConfigMap[K]): void;
  invalidate(scopeValue: string): void;
}

/**
 * Minimal structured-logger seam. Structurally compatible with
 * `@octabits-io/framework/logger`'s `Logger` (a superset). Optional — a noop
 * is used when omitted.
 */
export interface ScopedConfigLogger {
  warn(message: string, attributes?: Record<string, unknown>): void;
  error(message: string, error?: Error, attributes?: Record<string, unknown>): void;
}

const noopLogger: ScopedConfigLogger = { warn: () => {}, error: () => {} };

/**
 * Policy for a **present** stored row whose value fails schema validation on
 * read (e.g. a legacy row written under an older, looser schema):
 *
 *   - `'use-default'` (default) — warn and fall back to the schema default via
 *     the absent-row path, so a documented-defaulted key is never silently
 *     dropped. Best when config should always resolve to *something* usable.
 *   - `'skip'` — warn and leave the key **absent** from the result, exactly as
 *     if no row existed and the schema had no default. Best when a corrupt or
 *     legacy value must surface to the caller (as a missing key) rather than be
 *     masked by the default — e.g. a downstream guard that treats an absent key
 *     as an integrity error.
 *
 * Either way the failure is logged (key/scope/issue only — never the raw
 * value). Decrypt failures are unaffected: they always throw
 * {@link ScopedConfigDecryptError}.
 */
export type InvalidStoredValuePolicy = 'use-default' | 'skip';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Returned by `writeConfig` when a value fails schema validation. */
export interface InvalidConfigValueError extends OctError {
  key: 'scoped_config_invalid_value';
  message: string;
  /** The offending config key. */
  configKey: string;
}

export type ConfigDecryptFailureReason =
  | 'no_cipher'
  | 'decrypt_failed'
  | 'json_parse_failed';

/**
 * Thrown when a row marked `encrypted=true` cannot be read. Callers must not
 * silently substitute defaults — an encrypted value the operator wrote and we
 * can no longer decrypt is a data-integrity failure, not a "key not set"
 * situation, so this surfaces as a thrown error rather than a `Result`.
 */
export class ScopedConfigDecryptError extends Error {
  readonly configKey: string;
  readonly reason: ConfigDecryptFailureReason;
  constructor(configKey: string, reason: ConfigDecryptFailureReason, options?: { cause?: unknown }) {
    super(`Failed to read encrypted config "${configKey}" (${reason})`);
    this.name = 'ScopedConfigDecryptError';
    this.configKey = configKey;
    this.reason = reason;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

// ---------------------------------------------------------------------------
// Envelope + JSONB helpers
// ---------------------------------------------------------------------------

/** Wrapper format for encrypted values stored in the jsonb column. */
interface EncryptedValueWrapper {
  __encrypted: string;
}

function isEncryptedValueWrapper(value: unknown): value is EncryptedValueWrapper {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__encrypted' in value &&
    typeof (value as EncryptedValueWrapper).__encrypted === 'string'
  );
}

/**
 * Some drivers return jsonb objects/arrays as JSON strings rather than parsed
 * values (depends on the pg driver + Drizzle version). Re-parse those so a
 * schema expecting objects/arrays validates; primitives are left untouched.
 */
function parseJsonbValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  } catch {
    /* not valid JSON — keep as string */
  }
  return value;
}

/**
 * Assigns a schema-validated value into a config map. TypeScript cannot verify
 * that after a runtime discriminated-union parse the value matches `map[key]`
 * (it lacks dependent types), so the necessary assertion is isolated here — the
 * schema guarantees runtime safety.
 */
function assignConfigValue<TConfigMap extends Record<string, unknown>, K extends keyof TConfigMap>(
  target: Partial<TConfigMap>,
  key: K,
  value: TConfigMap[keyof TConfigMap],
): void {
  (target as Record<K, TConfigMap[K]>)[key] = value as TConfigMap[K];
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

/** Configuration for {@link createScopedConfigService}. */
export interface ScopedConfigServiceConfig<
  TConfigMap extends Record<string, unknown>,
  TScopeKey extends string = string,
  TCipherError extends OctError = OctError,
> {
  db: ConfigDatabase;
  /**
   * The config Drizzle table (columns per `../scope`'s `scopedConfigColumns`:
   * `key`, `value` jsonb, `encrypted` boolean, plus the consumer's own scope
   * column when scoped). Typed loosely so tables from a different `drizzle-orm`
   * copy interoperate; the required columns are accessed structurally.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  /**
   * Scope this instance is bound to (column property name + value). Omit for an
   * unscoped store — reads apply no scope filter and the upsert conflict target
   * is `(key)` alone. The conflict target must match the table's primary key:
   * `(scopeColumn, key)` when scoped, `(key)` when unscoped.
   */
  scope?: ConfigScope<TScopeKey>;
  /** Validates `{ key, value }` and applies per-key defaults. */
  schema: ConfigSchema<TConfigMap>;
  /** Keys whose values are encrypted at rest. */
  encryptedKeys?: Iterable<keyof TConfigMap>;
  /** Keys eligible for the cross-scope {@link ScopedConfigCache}. */
  cacheableKeys?: Iterable<keyof TConfigMap>;
  /**
   * All known config keys — enables `readAll()` to apply defaults for keys
   * that have no stored row. When omitted, `readAll()` only reflects rows
   * present in the table.
   */
  keys?: readonly (keyof TConfigMap)[];
  /** Raw-string encrypt/decrypt callbacks; required to read/write encrypted keys. */
  cipher?: ConfigCipher<TCipherError>;
  /** Optional cross-scope cache (build via {@link createScopedConfigCache}). */
  cache?: ScopedConfigCache<TConfigMap>;
  /** Optional structured logger; a noop is used when omitted. */
  logger?: ScopedConfigLogger;
  /**
   * How to handle a **present** stored row that fails schema validation on read.
   * Defaults to `'use-default'` (warn + apply the schema default). Use `'skip'`
   * to leave the key absent instead, surfacing corrupt/legacy values to the
   * caller rather than masking them behind the default. See
   * {@link InvalidStoredValuePolicy}.
   */
  onInvalidStoredValue?: InvalidStoredValuePolicy;
}

/** The public surface of a scoped config service. */
export interface ScopedConfigService<
  TConfigMap extends Record<string, unknown>,
  TCipherError extends OctError = OctError,
> {
  /**
   * Validate + persist a partial config. Each entry is schema-validated;
   * encrypted keys are ciphered into a `{ __encrypted }` envelope; all entries
   * are upserted in one statement. Returns the first validation error (nothing
   * is written) or a cipher error.
   *
   * **Cache-invalidation caveat:** a successful write invalidates only the
   * **in-process** caches (the request-scoped cache and the injected
   * cross-scope cache of *this* process). In multi-instance deployments other
   * processes keep serving their cached values until they expire — pair the
   * cross-scope cache with the recommended short TTL (e.g. 60s, see
   * {@link createScopedConfigCache}) to bound the staleness window.
   */
  writeConfig(config: Partial<TConfigMap>): Promise<Result<void, InvalidConfigValueError | TCipherError>>;
  /**
   * Read the requested keys, applying schema defaults for absent/invalid rows.
   * @throws {ScopedConfigDecryptError} if an `encrypted=true` row cannot be decrypted.
   */
  readConfig<K extends keyof TConfigMap>(...keys: K[]): Promise<{ [P in K]?: TConfigMap[P] }>;
  /**
   * Read every configured key (see `keys` in the config), applying defaults.
   * @throws {ScopedConfigDecryptError} if an `encrypted=true` row cannot be decrypted.
   */
  readAll(): Promise<Partial<TConfigMap>>;
}

/**
 * Create a config store over a Drizzle key/value table. Pass a `{ column,
 * value }` scope to partition rows (every read filtered, every upsert stamped,
 * conflict target `(scopeColumn, key)`); omit it for an unscoped store
 * (conflict target `(key)`). No tenant vocabulary.
 */
export function createScopedConfigService<
  TConfigMap extends Record<string, unknown>,
  TScopeKey extends string = string,
  TCipherError extends OctError = OctError,
>(
  config: ScopedConfigServiceConfig<TConfigMap, TScopeKey, TCipherError>,
): ScopedConfigService<TConfigMap, TCipherError> {
  const {
    db,
    table,
    scope,
    schema,
    cipher,
    cache,
    logger = noopLogger,
    onInvalidStoredValue = 'use-default',
  } = config;

  const encryptedKeys = new Set<keyof TConfigMap>(config.encryptedKeys ?? []);
  const cacheableKeys = new Set<keyof TConfigMap>(config.cacheableKeys ?? []);
  const allKeys = config.keys;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = table as any;
  // Partition key for the cross-scope cache + log context. Unscoped stores all
  // share one partition ('').
  const scopeValue = scope?.value ?? '';
  // Scope filter for reads; `undefined` when unscoped (no filter applied).
  const scopeCondition = (): SQL | undefined =>
    scope ? (eq(t[scope.column], scopeValue) as SQL) : undefined;

  // Request-scoped caches — safe because a config service is bound to one
  // scope and is expected to live for one request/unit of work.
  const requestScoped = new Map<keyof TConfigMap, TConfigMap[keyof TConfigMap]>();
  let allConfigsCache: Partial<TConfigMap> | null = null;

  function isEncrypted(key: keyof TConfigMap): boolean {
    return encryptedKeys.has(key);
  }
  function isCacheable(key: keyof TConfigMap): boolean {
    return cacheableKeys.has(key);
  }

  async function writeConfig(
    partial: Partial<TConfigMap>,
  ): Promise<Result<void, InvalidConfigValueError | TCipherError>> {
    const entries = Object.entries(partial) as Array<[keyof TConfigMap, TConfigMap[keyof TConfigMap]]>;
    if (entries.length === 0) return ok(undefined);

    const rows: Array<{ key: string; value: unknown; encrypted: boolean }> = [];

    for (const [key, value] of entries) {
      const parsed = schema.safeParse({ key: String(key), value });
      if (!parsed.success) {
        // Validation fails the whole write before anything is persisted.
        return err({
          key: 'scoped_config_invalid_value',
          message: `Invalid value for config key "${String(key)}": ${parsed.error.message}`,
          configKey: String(key),
        });
      }

      const hasValue = value !== null && value !== undefined;

      if (isEncrypted(key) && hasValue) {
        if (!cipher) {
          // No cipher for an encrypted key — store plaintext (matches the
          // permissive precedent) but make the gap loud.
          logger.warn('Cipher not available for encrypted config key; storing plaintext', {
            key: String(key),
            scope: scopeValue,
          });
          rows.push({ key: String(key), value, encrypted: false });
          continue;
        }
        const encryptResult = await cipher.encrypt(JSON.stringify(value));
        if (!encryptResult.ok) return encryptResult;
        const wrapper: EncryptedValueWrapper = { __encrypted: encryptResult.value };
        rows.push({ key: String(key), value: wrapper, encrypted: true });
        continue;
      }

      rows.push({ key: String(key), value: hasValue ? value : null, encrypted: false });
    }

    // JSON null must be written as an explicit jsonb null, not a SQL NULL.
    const sqlRows = rows.map((r) => ({
      ...(scope ? { [scope.column]: scopeValue } : {}),
      key: r.key,
      value: r.value === null ? sql`'null'::jsonb` : r.value,
      encrypted: r.encrypted,
    }));

    await db
      .insert(table)
      .values(sqlRows)
      .onConflictDoUpdate({
        // Must match the table's primary key: (scopeColumn, key) when scoped,
        // (key) alone when unscoped.
        target: scope ? [t.key, t[scope.column]] : [t.key],
        set: {
          value: sql`excluded.value`,
          encrypted: sql`excluded.encrypted`,
          // Keep the audit columns honest on the update path — column defaults
          // only fire on INSERT, so without these an upserted row keeps its
          // original updated_at forever. Guarded so tables without the
          // audit columns (not built from `scopedConfigColumns`) still work.
          ...(t.updatedAt ? { updatedAt: sql`now()` } : {}),
          ...(t.updatedBy ? { updatedBy: sql`excluded.updated_by` } : {}),
        },
      });

    // Invalidate caches after a successful write.
    requestScoped.clear();
    allConfigsCache = null;
    cache?.invalidate(scopeValue);

    return ok(undefined);
  }

  /**
   * Decrypts a row marked `encrypted=true`. Throws {@link ScopedConfigDecryptError}
   * on any failure so callers cannot silently substitute defaults.
   */
  async function decryptRow(key: keyof TConfigMap, value: unknown): Promise<unknown> {
    if (!cipher) {
      logger.error('Cannot decrypt config value — cipher not available', undefined, {
        key: String(key),
        scope: scopeValue,
      });
      throw new ScopedConfigDecryptError(String(key), 'no_cipher');
    }
    if (!isEncryptedValueWrapper(value)) {
      logger.error('Encrypted config row has non-wrapper value', undefined, {
        key: String(key),
        scope: scopeValue,
      });
      throw new ScopedConfigDecryptError(String(key), 'decrypt_failed');
    }
    const decryptResult = await cipher.decrypt(value.__encrypted);
    if (!decryptResult.ok) {
      logger.error('Failed to decrypt config value', undefined, {
        key: String(key),
        scope: scopeValue,
      });
      throw new ScopedConfigDecryptError(String(key), 'decrypt_failed', { cause: decryptResult.error });
    }
    try {
      return JSON.parse(decryptResult.value);
    } catch (cause) {
      logger.error('Failed to parse decrypted config value', undefined, {
        key: String(key),
        scope: scopeValue,
      });
      throw new ScopedConfigDecryptError(String(key), 'json_parse_failed', { cause });
    }
  }

  /**
   * Validate a raw `{ key, value }` through the schema (applying defaults) and,
   * on success, populate the result + request-scoped + shared caches.
   *
   * A **present** stored value that fails validation (e.g. a row written under
   * an older, looser schema before a type tightening) is handled per the
   * configured {@link InvalidStoredValuePolicy}:
   *
   *   - `'use-default'` (default) — warn and fall back to the schema default by
   *     re-absorbing `undefined`, i.e. the *exact* absent-row path. That keeps
   *     both cache tiers (request-scoped + cross-scope) identical to a
   *     genuinely-absent read and never writes the fallback back to the DB, so a
   *     documented-defaulted key never silently vanishes.
   *   - `'skip'` — warn and leave the key absent, surfacing the corrupt/legacy
   *     value to the caller instead of masking it behind the default.
   *
   * Either way the raw (possibly sensitive) value is never logged. Decrypt
   * failures are handled upstream in {@link decryptRow} and still throw — this
   * only covers plain schema-validation failures.
   */
  function absorb(target: Partial<TConfigMap>, key: keyof TConfigMap, rawValue: unknown): void {
    const parsed = schema.safeParse({ key: String(key), value: rawValue });
    if (parsed.success) {
      if (parsed.data.value !== undefined && parsed.data.value !== null) {
        assignConfigValue(target, key, parsed.data.value);
        requestScoped.set(key, parsed.data.value);
        if (cache) cache.set(scopeValue, key, parsed.data.value as TConfigMap[keyof TConfigMap]);
      }
      return;
    }

    // An absent value (no row, or a jsonb null) that fails validation simply has
    // no default to fall back to — leave the key out of the result, as before.
    const rowPresent = rawValue !== undefined && rawValue !== null;
    if (!rowPresent) return;

    // A stored row failed validation: warn, then apply the configured policy.
    logger.warn(
      onInvalidStoredValue === 'skip'
        ? 'Stored config value failed schema validation; leaving key absent'
        : 'Stored config value failed schema validation; applying schema default',
      { key: String(key), scope: scopeValue, issue: parsed.error.message },
    );
    // 'skip' → leave the key absent (surface corrupt/legacy values to the caller).
    if (onInvalidStoredValue === 'skip') return;
    // 'use-default' → apply the schema default via the absent-row path.
    // `absorb(undefined)` recurses at most once (undefined is not "present"), so
    // no infinite loop.
    absorb(target, key, undefined);
  }

  async function fetchRows(keys: Array<keyof TConfigMap>): Promise<Map<keyof TConfigMap, { value: unknown; encrypted: boolean }>> {
    const rows = (await db
      .select({ key: t.key, value: t.value, encrypted: t.encrypted })
      .from(table)
      .where(and(scopeCondition(), inArray(t.key, keys.map(String))))) as Array<{
      key: string;
      value: unknown;
      encrypted: boolean;
    }>;
    return new Map(rows.map((r) => [r.key as keyof TConfigMap, { value: r.value, encrypted: r.encrypted }]));
  }

  async function readConfig<K extends keyof TConfigMap>(...keys: K[]): Promise<{ [P in K]?: TConfigMap[P] }> {
    const result = {} as { [P in K]?: TConfigMap[P] };
    if (keys.length === 0) return result;

    const missing: K[] = [];
    for (const key of keys) {
      if (requestScoped.has(key)) {
        assignConfigValue(result as Partial<TConfigMap>, key, requestScoped.get(key)!);
      } else if (cache && isCacheable(key)) {
        const cached = cache.get(scopeValue, key);
        if (cached !== undefined) {
          assignConfigValue(result as Partial<TConfigMap>, key, cached as TConfigMap[keyof TConfigMap]);
          requestScoped.set(key, cached as TConfigMap[keyof TConfigMap]);
        } else {
          missing.push(key);
        }
      } else {
        missing.push(key);
      }
    }

    if (missing.length === 0) return result;

    const rowByKey = await fetchRows(missing);
    for (const key of missing) {
      const row = rowByKey.get(key);
      let value = parseJsonbValue(row?.value);
      if (row?.encrypted) value = await decryptRow(key, value);
      absorb(result as Partial<TConfigMap>, key, value);
    }

    return result;
  }

  async function readAll(): Promise<Partial<TConfigMap>> {
    // Return a shallow copy — handing out the internal cache object by
    // reference would let a caller's mutation poison every later readAll().
    if (allConfigsCache) return { ...allConfigsCache };

    const rows = (await db
      .select({ key: t.key, value: t.value, encrypted: t.encrypted })
      .from(table)
      .where(scopeCondition())) as Array<{ key: string; value: unknown; encrypted: boolean }>;
    const rowByKey = new Map(rows.map((r) => [r.key as keyof TConfigMap, { value: r.value, encrypted: r.encrypted }]));

    const result: Partial<TConfigMap> = {};
    // Iterate the declared key list (so defaults apply for absent keys) when
    // available; otherwise reflect only the rows present.
    const iterKeys: Array<keyof TConfigMap> = allKeys
      ? [...allKeys]
      : [...rowByKey.keys()];

    for (const key of iterKeys) {
      const row = rowByKey.get(key);
      let value = parseJsonbValue(row?.value);
      if (row?.encrypted) value = await decryptRow(key, value);
      absorb(result, key, value);
    }

    allConfigsCache = result;
    return { ...result };
  }

  return { writeConfig, readConfig, readAll };
}

// ---------------------------------------------------------------------------
// Cross-scope cache factory
// ---------------------------------------------------------------------------

/**
 * Structural LRU-cache seam — satisfied by a `@octabits-io/framework/utils`
 * `LruCache<string, unknown>`.
 */
export interface ConfigLruCache {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): boolean;
}

/**
 * Build a {@link ScopedConfigCache} over an injected LRU cache. Only cacheable
 * keys are stored (transactional keys are never cached); `invalidate` clears
 * every cacheable key for a scope. Recommend an LRU with TTL-based staleness
 * (e.g. 60s) for config that changes only via operator actions.
 */
export function createScopedConfigCache<TConfigMap extends Record<string, unknown>>({
  cache,
  cacheableKeys,
}: {
  cache: ConfigLruCache;
  cacheableKeys: Iterable<keyof TConfigMap>;
}): ScopedConfigCache<TConfigMap> {
  const cacheable = new Set<keyof TConfigMap>(cacheableKeys);
  // Encode both parts so a scope/key pair can never collide with another pair
  // across the ':' boundary (e.g. scope 'a' + key 'b:c' vs scope 'a:b' + key 'c').
  const cacheKey = (scopeValue: string, key: keyof TConfigMap) =>
    `${encodeURIComponent(scopeValue)}:${encodeURIComponent(String(key))}`;

  return {
    get<K extends keyof TConfigMap>(scopeValue: string, key: K): TConfigMap[K] | undefined {
      return cache.get(cacheKey(scopeValue, key)) as TConfigMap[K] | undefined;
    },
    set<K extends keyof TConfigMap>(scopeValue: string, key: K, value: TConfigMap[K]): void {
      if (!cacheable.has(key)) return;
      cache.set(cacheKey(scopeValue, key), value);
    },
    invalidate(scopeValue: string): void {
      for (const key of cacheable) cache.delete(cacheKey(scopeValue, key));
    },
  };
}
