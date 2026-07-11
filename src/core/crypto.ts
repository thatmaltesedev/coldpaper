/**
 * Encryption layer. WebCrypto only — no hand-rolled primitives.
 *
 *   key        = PBKDF2-HMAC-SHA256(passphrase, salt, 600 000 iterations, 256 bit)
 *   envelope   = salt (16 bytes) || iv (12 bytes) || AES-256-GCM ciphertext+tag
 *
 * The whole plaintext (metadata block + file content) goes inside the
 * envelope, so an encrypted backup leaks neither the filename nor the
 * plaintext hash. GCM's tag doubles as the wrong-passphrase detector.
 */
import { concatBytes, randomBytes, utf8Encode } from './bytes';
import { CpError } from './errors';

export const PBKDF2_ITERATIONS = 600_000;
export const SALT_LENGTH = 16;
export const IV_LENGTH = 12;
export const GCM_TAG_LENGTH = 16;

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', utf8Encode(passphrase) as BufferSource, 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export interface EncryptOptions {
  /** Fixed salt/iv/iterations exist ONLY for test vectors. Production always uses fresh randomness and 600k. */
  salt?: Uint8Array;
  iv?: Uint8Array;
  iterations?: number;
}

export async function encrypt(
  plaintext: Uint8Array,
  passphrase: string,
  options: EncryptOptions = {},
): Promise<Uint8Array> {
  const salt = options.salt ?? randomBytes(SALT_LENGTH);
  const iv = options.iv ?? randomBytes(IV_LENGTH);
  if (salt.length !== SALT_LENGTH || iv.length !== IV_LENGTH) {
    throw new CpError('INTERNAL', 'bad salt/iv length');
  }
  const key = await deriveKey(passphrase, salt, options.iterations ?? PBKDF2_ITERATIONS);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext as BufferSource),
  );
  return concatBytes([salt, iv, ciphertext]);
}

export async function decrypt(
  envelope: Uint8Array,
  passphrase: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<Uint8Array> {
  if (envelope.length < SALT_LENGTH + IV_LENGTH + GCM_TAG_LENGTH) {
    throw new CpError('CORRUPT_PAYLOAD', 'encrypted payload is too short to be a Coldpaper envelope');
  }
  const salt = envelope.subarray(0, SALT_LENGTH);
  const iv = envelope.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const ciphertext = envelope.subarray(SALT_LENGTH + IV_LENGTH);
  const key = await deriveKey(passphrase, salt, iterations);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      ciphertext as BufferSource,
    );
    return new Uint8Array(plain);
  } catch {
    throw new CpError(
      'BAD_PASSPHRASE',
      'decryption failed — almost always a wrong passphrase. Your scanned codes are fine; check the passphrase and try again.',
    );
  }
}
