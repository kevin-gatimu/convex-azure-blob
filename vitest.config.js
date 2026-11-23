import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    typecheck: {
      tsconfig: "./tsconfig.test.json",
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["example/**", "src/**/_generated/**", "src/**/*.test.ts"],
      // Floors at the measured coverage; raise them as tests are added.
      thresholds: {
        statements: 93,
        branches: 87,
        functions: 97,
        lines: 95,
        "src/client/**": {
          statements: 94,
          branches: 89,
          functions: 97,
          lines: 95,
        },
        "src/component/**": {
          statements: 89,
          branches: 82,
          functions: 100,
          lines: 93,
        },
        "src/react/**": {
          statements: 97,
          branches: 82,
          functions: 96,
          lines: 97,
        },
      },
    },
  },
});
