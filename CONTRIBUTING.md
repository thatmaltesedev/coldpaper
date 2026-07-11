# Contributing to coldpaper

Thanks for helping people's bytes outlive their hardware. A few ground rules
keep this project trustworthy.

## Setup

```sh
git clone https://github.com/thatmaltesedev/coldpaper.git
cd coldpaper
npm ci
npm run dev        # dev server
npm test           # full suite (vitest)
npm run typecheck  # tsc --noEmit
npm run build      # offline single-file build + PWA build into dist/
```

Node 20+ (CI runs 22). No global tooling beyond npm.

## What the tests mean

The suite is the product. In rough order of importance:

- `test/pdf-roundtrip.test.ts` — builds the real PDF, renders it with pdf.js,
  decodes every code with the bundled zxing, tears a page off, stains
  another, restores byte-identically. If your change breaks this, it broke
  the product promise.
- `test/qr-degradation.test.ts` — print-and-scan damage simulation
  (rotation, scale, noise, blur) against the bundled decoder.
- `test/roundtrip.test.ts`, `test/erasure.test.ts` — pipeline property tests
  across presets, passphrases, loss patterns.
- `test/crypto.test.ts`, `test/rs-vector.test.ts` — **frozen vectors that
  lock the code to FORMAT.md.** If one fails, the spec or the code moved;
  figure out which one is wrong before touching the vector.

New features need tests in the same spirit: prove behaviour, not coverage.

## The format is sacred

`FORMAT.md` is normative. Any change to bytes on paper — header fields, KDF
parameters, striping rule, metadata layout, anything — requires:

1. a format **version bump** (the version byte, encoder and decoder),
2. the decoder keeping the old version readable **forever** (paper printed
   today must restore in decades),
3. updated FORMAT.md with new frozen vectors and matching vector tests,
4. a very good reason. "Slightly nicer" is not one; printed backups can't be
   migrated by a script.

## Hard rules (from the README threat model)

- Crypto via WebCrypto only. No custom primitives, no crypto dependencies.
- Zero network requests at runtime. No CDNs, no analytics, no telemetry —
  the DevTools-Network-tab-is-empty claim is a feature.
- File bytes never persist: no localStorage/IndexedDB/cookies for content.
- Every dependency is pinned exactly; additions need a strong case and a
  license check (MIT/BSD/Apache-2.0 compatible).

## Style

- TypeScript strict; vanilla DOM (no frameworks); hand-written CSS.
- Comments explain *constraints and why*, not what the next line does.
- Conventional commits (`feat(scope): …`, `fix: …`, `docs: …`, `test: …`).

## Reporting security issues

Open a GitHub security advisory (private) rather than a public issue if the
problem could endanger existing printed backups or leak plaintext. Honest
threat-model corrections to the README are welcome as normal PRs.
