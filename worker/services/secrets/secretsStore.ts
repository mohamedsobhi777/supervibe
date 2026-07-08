/**
 * User Secrets Store - Postgres storage layer.
 *
 * Pure storage functions over the `user_secrets` table (see
 * `worker/database/schema.ts`). The app-layer XChaCha20-Poly1305 crypto -
 * VMK/SK derived and held client-side - is unchanged by this port: these
 * functions move ciphertext bytes and plaintext lookup metadata in and
 * out of Postgres and never see, derive, or return a secret's plaintext
 * value.
 *
 * This replaces the storage half of the retired `UserSecretsStore`
 * Durable Object (`./UserSecretsStore.ts`), which also owned a WebSocket
 * session protocol that is not ported here - a REST layer is added over
 * these functions separately.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../../database/schema';
import { generateId } from '../../utils/idGenerator';
import type {
	EncryptedSecret,
	SecretListItem,
	SecretMetadata,
	SecretType,
	StoreSecretRequest,
} from './vault-types';

type Db = PostgresJsDatabase<typeof schema>;
type SecretRow = typeof schema.userSecrets.$inferSelect;

/** Crypto-module output (ArrayBuffer) -> bytea column input (Buffer). */
function toBuffer(data: ArrayBuffer): Buffer {
	return Buffer.from(data);
}

/** bytea column output (Buffer) -> the Uint8Array shape vault-types uses. */
function toBytes(data: Buffer): Uint8Array<ArrayBuffer> {
	return new Uint8Array(data);
}

function toMetadata(value: unknown): SecretMetadata | undefined {
	return value ? (value as SecretMetadata) : undefined;
}

function toEncryptedSecret(row: SecretRow): EncryptedSecret {
	return {
		id: row.id,
		encryptedValue: toBytes(row.encryptedValue),
		valueNonce: toBytes(row.valueNonce),
		encryptedName: toBytes(row.encryptedName),
		nameNonce: toBytes(row.nameNonce),
		metadata: toMetadata(row.metadata),
		secretType: row.secretType as SecretType,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	};
}

/**
 * Inserts a new secret row. `payload` carries ciphertext produced
 * client-side (VMK-encrypted value/name plus their nonces) and plaintext
 * lookup metadata (provider, envVarName, ...) - never the secret's
 * plaintext value, which this layer never receives.
 */
export async function storeSecret(db: Db, userId: string, payload: StoreSecretRequest): Promise<{ id: string }> {
	const id = generateId();

	const [created] = await db
		.insert(schema.userSecrets)
		.values({
			id,
			userId,
			secretType: payload.secretType,
			encryptedName: toBuffer(payload.encryptedName),
			nameNonce: toBuffer(payload.nameNonce),
			encryptedValue: toBuffer(payload.encryptedValue),
			valueNonce: toBuffer(payload.valueNonce),
			metadata: payload.metadata ?? null,
		})
		.returning({ id: schema.userSecrets.id });

	return { id: created.id };
}

/**
 * Lists a user's secrets, newest first. Returns name ciphertext and
 * plaintext metadata only - not the value ciphertext - matching the
 * minimal-payload shape the retired DO used for listings; callers fetch
 * the full secret via `getSecret` when they need the value.
 */
export async function listSecrets(db: Db, userId: string): Promise<SecretListItem[]> {
	const rows = await db
		.select({
			id: schema.userSecrets.id,
			encryptedName: schema.userSecrets.encryptedName,
			nameNonce: schema.userSecrets.nameNonce,
			metadata: schema.userSecrets.metadata,
			secretType: schema.userSecrets.secretType,
			createdAt: schema.userSecrets.createdAt,
			updatedAt: schema.userSecrets.updatedAt,
		})
		.from(schema.userSecrets)
		.where(eq(schema.userSecrets.userId, userId))
		.orderBy(desc(schema.userSecrets.createdAt));

	return rows.map((row) => ({
		id: row.id,
		encryptedName: toBytes(row.encryptedName),
		nameNonce: toBytes(row.nameNonce),
		metadata: toMetadata(row.metadata),
		secretType: row.secretType as SecretType,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	}));
}

/**
 * Fetches one secret's full ciphertext (value + name), scoped to
 * `userId` so a caller can never read another user's row even if the id
 * leaks.
 */
export async function getSecret(db: Db, userId: string, id: string): Promise<EncryptedSecret | null> {
	const rows = await db
		.select()
		.from(schema.userSecrets)
		.where(and(eq(schema.userSecrets.id, id), eq(schema.userSecrets.userId, userId)))
		.limit(1);

	const row = rows[0];
	return row ? toEncryptedSecret(row) : null;
}

/**
 * Deletes one secret, scoped to `userId`. Returns `false` rather than
 * throwing when the row doesn't exist or belongs to another user.
 */
export async function deleteSecret(db: Db, userId: string, id: string): Promise<boolean> {
	const deleted = await db
		.delete(schema.userSecrets)
		.where(and(eq(schema.userSecrets.id, id), eq(schema.userSecrets.userId, userId)))
		.returning({ id: schema.userSecrets.id });

	return deleted.length > 0;
}
