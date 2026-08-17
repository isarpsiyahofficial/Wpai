import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/shared/**/*.ts', 'src/worker/infrastructure.ts'],
      thresholds: { statements: 75, branches: 65, functions: 75, lines: 75 }
    }
  }
});
