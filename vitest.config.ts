import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    include: [
      'apps/**/*.test.ts',
      'apps/**/*.spec.ts',
      'packages/**/*.test.ts',
      'packages/**/*.spec.ts',
      'test/**/*.test.ts',
      'test/**/*.spec.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: 'coverage',
      include: ['apps/**/src/**/*.ts', 'packages/**/src/**/*.ts'],
      exclude: [
        'apps/mcp-server/src/cli.ts',
        'apps/mcp-server/src/http/cli.ts',
        // The demo is exercised as a built black-box child process so V8 cannot
        // attribute its execution back into this Vitest process.
        'apps/demo/src/server.ts',
        // Browser interaction belongs to the browser E2E lane; the production
        // bundle is still compiled and typechecked by the canonical gate.
        'apps/demo/client/**',
      ],
      thresholds: {
        branches: 80,
        functions: 85,
        lines: 85,
        statements: 85,
      },
    },
  },
});
