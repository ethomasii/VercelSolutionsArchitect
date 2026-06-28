// AES-256-GCM encryption for stored integration secrets.
//
// Key resolution order:
//   1. DISPATCH_ENCRYPTION_KEY env var (32-byte base64) — use in production
//   2. SHA-256 hash of DATABASE_URL — stable per deployment, works without config
//
// To generate a production key:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
// Then: vercel env add DISPATCH_ENCRYPTION_KEY

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ALGO = 'aes-256-gcm';
const ENCRYPTED_PREFIX = 'enc:v1:';

function getKey(): Buffer {
  const envKey = process.env.DISPATCH_ENCRYPTION_KEY;
  if (envKey) {
    return Buffer.from(envKey, 'base64');
  }
  // Deterministic fallback: SHA-256 of DATABASE_URL.
  // Stable across restarts so stored values can always be decrypted.
  // Not ideal for production — set DISPATCH_ENCRYPTION_KEY for proper key management.
  const seed = process.env.DATABASE_URL ?? 'dispatch-local-dev-key-not-for-production';
  return createHash('sha256').update(seed).digest();
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: enc:v1:{iv}:{authTag}:{data} — all base64, colon-separated
  return `${ENCRYPTED_PREFIX}${iv.toString('base64url')}:${authTag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function decryptSecret(ciphertext: string): string {
  if (!ciphertext.startsWith(ENCRYPTED_PREFIX)) {
    // Plaintext value (migration path: values stored before encryption was added)
    return ciphertext;
  }
  const key = getKey();
  const body = ciphertext.slice(ENCRYPTED_PREFIX.length);
  const [ivB64, authTagB64, dataB64] = body.split(':');
  const iv = Buffer.from(ivB64, 'base64url');
  const authTag = Buffer.from(authTagB64, 'base64url');
  const data = Buffer.from(dataB64, 'base64url');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

export const MASK = '••••••••';

export function isMasked(value: string): boolean {
  return value === MASK;
}
