import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./test/global-setup.ts"],
    // Integration tests share one database, so files run one after another.
    fileParallelism: false,
    testTimeout: 15_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL:
        process.env.DATABASE_URL_TEST ?? "postgres://postgres:postgres@localhost:5432/wallet_test",
      REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379/1",
      JWT_SECRET: "test-secret-with-at-least-32-characters!!",
      LOG_LEVEL: "silent",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/main.ts", "src/relay.ts", "src/db/migrate.ts"],
    },
  },
});
