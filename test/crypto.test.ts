import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from '../src/core/bytes';
import { decrypt, encrypt, GCM_TAG_LENGTH, IV_LENGTH, SALT_LENGTH } from '../src/core/crypto';
import { isCpError } from '../src/core/errors';
import { mulberry32, randomBytes } from './helpers/rng';

const rand = mulberry32(555);
const FAST = 1000; // keep bulk tests quick; the frozen vector below uses the real 600k

describe('crypto envelope', () => {
  it('matches the frozen FORMAT.md test vector (600 000 PBKDF2 iterations)', async () => {
    // Independently derived with plain WebCrypto (see FORMAT.md §6.4).
    const envelope = await encrypt(
      new TextEncoder().encode('coldpaper test vector 001'),
      'correct horse battery staple',
      {
        salt: fromHex('000102030405060708090a0b0c0d0e0f'),
        iv: fromHex('000102030405060708090a0b'),
      },
    );
    expect(toHex(envelope)).toBe(
      '000102030405060708090a0b0c0d0e0f000102030405060708090a0b' +
        '6da9e4e501d54ce99e09f326cfc9a8cb80fac944ac6ab7040f97742eb4199c229f8e3b3d3c20958072',
    );
    const plain = await decrypt(envelope, 'correct horse battery staple');
    expect(new TextDecoder().decode(plain)).toBe('coldpaper test vector 001');
  });

  it('round-trips various sizes', async () => {
    for (const n of [0, 1, 17, 1000, 60_000]) {
      const plain = randomBytes(rand, n);
      const envelope = await encrypt(plain, 'hunter2', { iterations: FAST });
      expect(envelope.length).toBe(SALT_LENGTH + IV_LENGTH + n + GCM_TAG_LENGTH);
      const back = await decrypt(envelope, 'hunter2', FAST);
      expect(back).toEqual(plain);
    }
  });

  it('uses fresh random salt and iv every time', async () => {
    const plain = randomBytes(rand, 64);
    const a = await encrypt(plain, 'pw', { iterations: FAST });
    const b = await encrypt(plain, 'pw', { iterations: FAST });
    expect(toHex(a.subarray(0, SALT_LENGTH))).not.toBe(toHex(b.subarray(0, SALT_LENGTH)));
    expect(toHex(a.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH))).not.toBe(
      toHex(b.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH)),
    );
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it('rejects a wrong passphrase with BAD_PASSPHRASE', async () => {
    const envelope = await encrypt(randomBytes(rand, 500), 'right horse', { iterations: FAST });
    try {
      await decrypt(envelope, 'wrong horse', FAST);
      expect.unreachable();
    } catch (e) {
      expect(isCpError(e, 'BAD_PASSPHRASE')).toBe(true);
    }
  });

  it('rejects any tampered ciphertext byte (GCM authentication)', async () => {
    const envelope = await encrypt(randomBytes(rand, 100), 'pw', { iterations: FAST });
    for (const pos of [SALT_LENGTH + IV_LENGTH, envelope.length - 1]) {
      const copy = Uint8Array.from(envelope);
      copy[pos] ^= 0x80;
      await expect(decrypt(copy, 'pw', FAST)).rejects.toSatisfy((e) => isCpError(e, 'BAD_PASSPHRASE'));
    }
  });

  it('rejects an impossibly short envelope as CORRUPT_PAYLOAD', async () => {
    await expect(decrypt(new Uint8Array(10), 'pw', FAST)).rejects.toSatisfy((e) =>
      isCpError(e, 'CORRUPT_PAYLOAD'),
    );
  });
});
