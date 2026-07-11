/** Machine-readable error codes for everything that can go wrong in the pipeline. */
export type CpErrorCode =
  /** The scanned bytes are not a Coldpaper chunk at all. */
  | 'NOT_COLDPAPER'
  /** The chunk declares a format version this decoder does not understand. */
  | 'UNSUPPORTED_VERSION'
  /** The chunk's CRC-32 does not match (mis-scan or text-mode mangling). */
  | 'BAD_CHECKSUM'
  /** A chunk's header disagrees with other chunks of the same backup. */
  | 'CHUNK_MISMATCH'
  /** Not enough chunks captured to reconstruct one or more groups. */
  | 'INSUFFICIENT_CHUNKS'
  /** The backup is encrypted and no passphrase was supplied. */
  | 'PASSPHRASE_REQUIRED'
  /** AES-GCM authentication failed — almost always a wrong passphrase. */
  | 'BAD_PASSPHRASE'
  /** The restored bytes do not hash to the fingerprint stored in the backup. */
  | 'HASH_MISMATCH'
  /** Reconstructed payload is structurally broken (bad envelope, failed inflate). */
  | 'CORRUPT_PAYLOAD'
  /** Input exceeds what the format (or the app's hard cap) can hold. */
  | 'FILE_TOO_LARGE'
  /** A bug: an invariant the code relies on was violated. */
  | 'INTERNAL';

export class CpError extends Error {
  constructor(
    public readonly code: CpErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CpError';
  }
}

export function isCpError(e: unknown, code?: CpErrorCode): e is CpError {
  return e instanceof CpError && (code === undefined || e.code === code);
}
