import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

// Locate .env at the repo root, whether running from src (ts-node) or dist.
const candidatePaths = [
  path.resolve(__dirname, '../.env'), // repo root from src/ or dist/
  path.resolve(process.cwd(), '.env'), // when cwd is the repo root
];

for (const envPath of candidatePaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}

// Validate JWT_SECRET at boot
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.trim() === '') {
  throw new Error(
    'JWT_SECRET environment variable is required and must not be empty. ' +
      'Set it in the repo-root .env file.',
  );
}

// Validate WALLET_CREDENTIALS_KEY at boot (fail-fast, same pattern as JWT_SECRET).
// Used to encrypt/decrypt per-tenant Google Wallet private keys at rest.
const WALLET_CREDENTIALS_KEY = process.env.WALLET_CREDENTIALS_KEY;
if (!WALLET_CREDENTIALS_KEY || WALLET_CREDENTIALS_KEY.trim() === '') {
  throw new Error(
    'WALLET_CREDENTIALS_KEY environment variable is required and must not be empty. ' +
      'Set it in .env (32+ char random string; e.g. `openssl rand -hex 32`).',
  );
}

// AES-256-GCM needs a 32-byte key. Derive one deterministically from whatever
// string length the operator provides via SHA-256, rather than rejecting
// keys that aren't exactly 32 bytes.
const ENCRYPTION_KEY = crypto
  .createHash('sha256')
  .update(WALLET_CREDENTIALS_KEY)
  .digest();

const GCM_IV_LENGTH = 12;

/**
 * Encrypts a private key (or any string) at rest with AES-256-GCM.
 * Output format: `<iv>:<authTag>:<ciphertext>`, all hex-encoded, so it's a
 * single TEXT column value with everything needed to decrypt.
 */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString('hex'),
    authTag.toString('hex'),
    encrypted.toString('hex'),
  ].join(':');
}

/**
 * Decrypts a value produced by encryptSecret.
 */
export function decryptSecret(ciphertextPacked: string): string {
  const [ivHex, authTagHex, dataHex] = ciphertextPacked.split(':');
  if (!ivHex || !authTagHex || !dataHex) {
    throw new Error(
      'Malformed encrypted secret (expected iv:authTag:ciphertext).',
    );
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    ENCRYPTION_KEY,
    Buffer.from(ivHex, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export { JWT_SECRET };
