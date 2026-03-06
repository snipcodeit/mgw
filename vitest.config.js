import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.js'],
    // Target .test.js and .spec.js files for vitest
    // Exclude .test.cjs files — those use node:test (run via npm run test:node)
    include: ['test/**/*.{test,spec}.{js,mjs}'],
    exclude: ['test/**/*.test.cjs'],
  },
});
