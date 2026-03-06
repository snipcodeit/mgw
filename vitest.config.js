import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.js'],
    // Target .test.js and .spec.js files for vitest
    // Exclude .test.cjs files — those use node:test (run via npm run test:node)
    include: ['test/**/*.{test,spec}.{js,mjs}'],
    exclude: ['test/**/*.test.cjs'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      thresholds: {
        lines: 70,
      },
      exclude: [
        'node_modules/**',
        'dist/**',
        'coverage/**',
        '**/*.test.{js,cjs,mjs}',
        '**/*.config.{js,cjs,mjs}',
        'bin/mgw-install.cjs',
        'bin/generate-completions.cjs',
        'completions/**',
        'templates/**',
        'commands/**',
        'wiki/**',
        'docs/**',
        'test/**',
        '.planning/**',
        '.mgw/**',
      ],
    },
  },
});
