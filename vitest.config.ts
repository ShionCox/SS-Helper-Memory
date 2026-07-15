import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

function fixture(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: {
      '../../../SDK/tavern': fixture('./test/fixtures/sdk/tavern.ts'),
      '../../../SDK/logger': fixture('./test/fixtures/sdk/logger.ts'),
      '../../../SDK/toast': fixture('./test/fixtures/sdk/toast.ts'),
      '../../../SDK/tailwind.css': fixture('./test/fixtures/sdk/tailwind.css'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.verification-temp/**',
      '**/test-results/**',
      '**/coverage/**',
    ],
    testTimeout: 10_000,
  },
});
