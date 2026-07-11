import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The degradation and printed-PDF simulations do real rasterisation and
    // wasm decoding; give them room.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
