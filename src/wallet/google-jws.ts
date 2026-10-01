import * as crypto from 'crypto';

/**
 * Phase 7.2 — full verification of Google Wallet callback signatures,
 * replacing the Phase 0.3 stopgap (a shared secret in the URL path, which
 * only ever gated the destructive `del` branch).
 *
 * Google Wallet callbacks are signed with the Google Pay **ECv2SigningOnly**
 * scheme, not a JWT — which is why `jwt.verify` was never an option here.
 * The chain is:
 *
 *   Google root signing key  ──signs──▶  intermediate signing key
 *   intermediate signing key ──signs──▶  the callback's signedMessage
 *
 * and both links are ECDSA-P256/SHA-256 over a length-prefixed byte string,
 * so a forged `{"eventType":"del"}` (SEC-2) can no longer soft-delete a pass.
 */

const ROOT_KEYS_URL = 'https://pay.google.com/gp/m/issuer/keys';
const SENDER_ID = 'GooglePayPasses';
const PROTOCOL = 'ECv2SigningOnly';

export interface SignedCallbackEnvelope {
  signature?: string;
  intermediateSigningKey?: {
    signedKey?: string;
    signatures?: string[];
  };
  protocolVersion?: string;
  signedMessage?: string;
}

export class SignatureError extends Error {}

/**
 * Google Pay's canonical signed-byte encoding: each component is prefixed
 * with its UTF-8 byte length as a 4-byte little-endian integer. The length
 * prefixes are the point — plain concatenation would let an attacker move
 * bytes across component boundaries and sign a different message with the
 * same bytes.
 */
function toSignedBytes(...parts: string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length, 0);
    chunks.push(len, bytes);
  }
  return Buffer.concat(chunks);
}

function publicKeyFromBase64(keyValue: string): crypto.KeyObject {
  return crypto.createPublicKey({
    key: Buffer.from(keyValue, 'base64'),
    format: 'der',
    type: 'spki',
  });
}

function verifyOne(
  message: Buffer,
  signatureB64: string,
  key: crypto.KeyObject,
): boolean {
  try {
    return crypto.verify(
      'sha256',
      message,
      key,
      Buffer.from(signatureB64, 'base64'),
    );
  } catch {
    // A malformed DER signature or a key of the wrong curve throws rather
    // than returning false. Either way this signature did not verify.
    return false;
  }
}

interface RootKey {
  keyValue: string;
  protocolVersion: string;
  keyExpiration?: string;
}

let rootKeyCache: { keys: RootKey[]; fetchedAt: number } | null = null;
const ROOT_KEY_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Google rotates these; they are public and cacheable. On a fetch failure
 * with a warm cache we keep serving the cached set rather than failing every
 * inbound callback for as long as pay.google.com is unreachable.
 */
export async function fetchRootKeys(force = false): Promise<RootKey[]> {
  if (
    !force &&
    rootKeyCache &&
    Date.now() - rootKeyCache.fetchedAt < ROOT_KEY_TTL_MS
  ) {
    return rootKeyCache.keys;
  }
  try {
    const res = await fetch(ROOT_KEYS_URL);
    if (!res.ok) throw new Error(`root key fetch returned ${res.status}`);
    const body: any = await res.json();
    const keys: RootKey[] = body?.keys || [];
    if (!keys.length) throw new Error('root key document contained no keys');
    rootKeyCache = { keys, fetchedAt: Date.now() };
    return keys;
  } catch (err) {
    if (rootKeyCache) return rootKeyCache.keys;
    throw new SignatureError(
      `Unable to fetch Google root signing keys: ${(err as Error).message}`,
    );
  }
}

/** Test seam: lets the unit test install a known root key set. */
export function __setRootKeyCache(keys: RootKey[] | null) {
  rootKeyCache = keys ? { keys, fetchedAt: Date.now() } : null;
}

function notExpired(expirationMillis?: string): boolean {
  if (!expirationMillis) return true;
  const ms = Number(expirationMillis);
  return !Number.isFinite(ms) || ms > Date.now();
}

/**
 * Verifies the envelope and returns the parsed `signedMessage`.
 *
 * @param issuerId the recipient id Google signed for — the Wallet issuer id.
 * @throws SignatureError on anything that is not a fully verified callback.
 */
export async function verifyWalletCallback(
  envelope: SignedCallbackEnvelope,
  issuerId: string,
): Promise<any> {
  const { signature, intermediateSigningKey, protocolVersion, signedMessage } =
    envelope || {};

  if (protocolVersion !== PROTOCOL) {
    throw new SignatureError(
      `Unsupported protocolVersion ${protocolVersion ?? '(missing)'} — expected ${PROTOCOL}.`,
    );
  }
  if (!signature || !signedMessage) {
    throw new SignatureError('Callback is missing signature or signedMessage.');
  }
  const signedKeyJson = intermediateSigningKey?.signedKey;
  const intermediateSignatures = intermediateSigningKey?.signatures || [];
  if (!signedKeyJson || !intermediateSignatures.length) {
    throw new SignatureError(
      'Callback is missing its intermediate signing key.',
    );
  }
  if (!issuerId) {
    throw new SignatureError(
      'No issuer id available to verify the callback recipient against.',
    );
  }

  // Link 1 — a Google root key signed the intermediate key.
  const rootKeys = (await fetchRootKeys()).filter(
    (k) => k.protocolVersion === PROTOCOL && notExpired(k.keyExpiration),
  );
  if (!rootKeys.length) {
    throw new SignatureError(
      `No unexpired Google root key for protocol ${PROTOCOL}.`,
    );
  }

  const intermediateBytes = toSignedBytes(SENDER_ID, PROTOCOL, signedKeyJson);
  const rootVerified = rootKeys.some((root) => {
    let key: crypto.KeyObject;
    try {
      key = publicKeyFromBase64(root.keyValue);
    } catch {
      return false;
    }
    return intermediateSignatures.some((sig) =>
      verifyOne(intermediateBytes, sig, key),
    );
  });
  if (!rootVerified) {
    throw new SignatureError(
      'Intermediate signing key is not signed by any current Google root key.',
    );
  }

  let signedKey: { keyValue?: string; keyExpiration?: string };
  try {
    signedKey = JSON.parse(signedKeyJson);
  } catch {
    throw new SignatureError('Intermediate signedKey is not valid JSON.');
  }
  if (!signedKey.keyValue) {
    throw new SignatureError('Intermediate signedKey carries no keyValue.');
  }
  if (!notExpired(signedKey.keyExpiration)) {
    throw new SignatureError('Intermediate signing key has expired.');
  }

  // Link 2 — the intermediate key signed this message, for this issuer.
  const messageBytes = toSignedBytes(
    SENDER_ID,
    issuerId,
    PROTOCOL,
    signedMessage,
  );
  if (
    !verifyOne(messageBytes, signature, publicKeyFromBase64(signedKey.keyValue))
  ) {
    throw new SignatureError('signedMessage signature did not verify.');
  }

  try {
    return JSON.parse(signedMessage);
  } catch {
    throw new SignatureError('Verified signedMessage is not valid JSON.');
  }
}

export const __test = { toSignedBytes };
