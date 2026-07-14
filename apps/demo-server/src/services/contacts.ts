/**
 * Contacts service — the PII showcase.
 *
 * `email` is stored twice, in two shapes, neither of them readable:
 *   - `email_encrypted` — age hybrid encryption (X25519 + ChaCha20-Poly1305).
 *     Only a holder of the age identity can read it back.
 *   - `email_index` — an HMAC-SHA256 blind index over the canonicalized value
 *     (NFKC → lowercase → trim). Deterministic, so exact-match search works;
 *     keyed, so it is not a reversible hash of the address.
 *
 * `createBaseCrudService` (`…/drizzle/crud`) is deliberately NOT used here: it
 * maps table columns straight to entity fields, and this flow has to encrypt on
 * the way in and decrypt on the way out — two async, fallible steps per row that
 * the generic factory has no seam for. `notes.ts` uses it instead.
 */
import { count, eq } from 'drizzle-orm';
import { ok, err } from '@octabits-io/framework/result';
import type { OctError, Result } from '@octabits-io/framework/result';
import { withDbErrorHandling } from '@octabits-io/framework/drizzle/db';
import type { OctDatabaseError } from '@octabits-io/framework/drizzle/db';
import { normalizePaginationLimit } from '@octabits-io/framework/drizzle/db';
import type { BlindIndexService, PiiEncryptionService } from '@octabits-io/framework/pii';
import type { DateProvider } from '@octabits-io/framework/utils';
import type { AppDatabase } from '@octabits-io/framework/drizzle/factory';
import { contacts, type Schema } from '../db/schema.ts';

export interface Contact {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContactNotFoundError extends OctError {
  key: 'contact_not_found';
}

/** Encrypt/decrypt failures surface as a distinct key so routes can map them. */
export interface ContactCryptoError extends OctError {
  key: 'contact_crypto_error';
}

export type ContactReadError = ContactCryptoError | OctDatabaseError;
export type ContactWriteError = ContactCryptoError | OctDatabaseError;
export type ContactByIdError = ContactNotFoundError | ContactReadError;

export interface ContactsServiceDeps {
  db: AppDatabase<Schema>;
  pii: PiiEncryptionService;
  blindIndex: BlindIndexService;
  dateProvider: DateProvider;
}

interface ContactRow {
  id: string;
  name: string;
  emailEncrypted: Buffer;
  createdAt: Date;
  updatedAt: Date;
}

const cryptoError = (message: string): ContactCryptoError => ({
  key: 'contact_crypto_error',
  message,
});

const notFound = (id: string): ContactNotFoundError => ({
  key: 'contact_not_found',
  message: `Contact ${id} not found`,
});

export function createContactsService({ db, pii, blindIndex, dateProvider }: ContactsServiceDeps) {
  /** Decrypt one row into the API entity. */
  async function toContact(row: ContactRow): Promise<Result<Contact, ContactCryptoError>> {
    const email = await pii.decryptString(row.emailEncrypted);
    if (!email.ok) return err(cryptoError(`Failed to decrypt contact email: ${email.error.message}`));
    return ok({
      id: row.id,
      name: row.name,
      // A NOT NULL ciphertext column can only decrypt to null if the row was
      // written with an empty string — treat that as an empty address.
      email: email.value ?? '',
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  async function toContacts(rows: ContactRow[]): Promise<Result<Contact[], ContactCryptoError>> {
    const out: Contact[] = [];
    for (const row of rows) {
      const contact = await toContact(row);
      if (!contact.ok) return contact;
      out.push(contact.value);
    }
    return ok(out);
  }

  /** Build the two derived columns an email produces. */
  async function encryptEmail(
    email: string,
  ): Promise<Result<{ emailEncrypted: Buffer; emailIndex: Buffer }, ContactCryptoError>> {
    const encrypted = await pii.encryptString(email);
    if (!encrypted.ok) return err(cryptoError(`Failed to encrypt email: ${encrypted.error.message}`));
    const index = blindIndex.generateIndex(email);
    if (!encrypted.value || !index) return err(cryptoError('Email must not be empty'));
    return ok({ emailEncrypted: encrypted.value, emailIndex: index });
  }

  const SELECT_COLUMNS = {
    id: contacts.id,
    name: contacts.name,
    emailEncrypted: contacts.emailEncrypted,
    createdAt: contacts.createdAt,
    updatedAt: contacts.updatedAt,
  };

  async function list(params: {
    page: number;
    pageSize: number;
  }): Promise<Result<{ items: Contact[]; total: number; page: number; pageSize: number }, ContactReadError>> {
    return withDbErrorHandling(async () => {
      const limit = normalizePaginationLimit(params.pageSize);
      const offset = (params.page - 1) * limit;

      const [rows, totals] = await Promise.all([
        db.select(SELECT_COLUMNS).from(contacts).orderBy(contacts.createdAt).limit(limit).offset(offset),
        db.select({ value: count() }).from(contacts),
      ]);

      const items = await toContacts(rows);
      if (!items.ok) return items;

      return ok({
        items: items.value,
        total: totals[0]?.value ?? 0,
        page: params.page,
        pageSize: limit,
      });
    });
  }

  async function getById(id: string): Promise<Result<Contact, ContactByIdError>> {
    // The error type is passed explicitly: inference picks a single branch of a
    // multi-error callback and then rejects the others.
    return withDbErrorHandling<Contact, ContactNotFoundError | ContactCryptoError>(async () => {
      const [row] = await db.select(SELECT_COLUMNS).from(contacts).where(eq(contacts.id, id)).limit(1);
      if (!row) return err(notFound(id));
      return toContact(row);
    });
  }

  async function searchByEmail(email: string): Promise<Result<Contact[], ContactReadError>> {
    return withDbErrorHandling(async () => {
      const index = blindIndex.generateIndex(email);
      // An empty/whitespace query indexes to null — no row can match it.
      if (!index) return ok([]);
      const rows = await db.select(SELECT_COLUMNS).from(contacts).where(eq(contacts.emailIndex, index));
      return toContacts(rows);
    });
  }

  async function create(params: { name: string; email: string }): Promise<Result<Contact, ContactWriteError>> {
    const encrypted = await encryptEmail(params.email);
    if (!encrypted.ok) return encrypted;

    return withDbErrorHandling(async () => {
      const [row] = await db
        .insert(contacts)
        .values({ name: params.name, ...encrypted.value })
        .returning(SELECT_COLUMNS);
      if (!row) return err(cryptoError('Insert returned no row'));
      return toContact(row);
    });
  }

  async function update(
    id: string,
    params: { name?: string; email?: string },
  ): Promise<Result<Contact, ContactByIdError>> {
    const changes: Partial<typeof contacts.$inferInsert> = { updatedAt: dateProvider.now() };
    if (params.name !== undefined) changes.name = params.name;
    if (params.email !== undefined) {
      const encrypted = await encryptEmail(params.email);
      if (!encrypted.ok) return encrypted;
      changes.emailEncrypted = encrypted.value.emailEncrypted;
      changes.emailIndex = encrypted.value.emailIndex;
    }

    return withDbErrorHandling<Contact, ContactNotFoundError | ContactCryptoError>(async () => {
      const [row] = await db.update(contacts).set(changes).where(eq(contacts.id, id)).returning(SELECT_COLUMNS);
      if (!row) return err(notFound(id));
      return toContact(row);
    });
  }

  async function remove(id: string): Promise<Result<void, ContactNotFoundError | OctDatabaseError>> {
    return withDbErrorHandling(async () => {
      const rows = await db.delete(contacts).where(eq(contacts.id, id)).returning({ id: contacts.id });
      if (rows.length === 0) return err(notFound(id));
      return ok(undefined);
    });
  }

  return { list, getById, searchByEmail, create, update, remove };
}

export type ContactsService = ReturnType<typeof createContactsService>;
