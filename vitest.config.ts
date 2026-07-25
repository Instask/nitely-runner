import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 20_000,
    exclude: [...configDefaults.exclude, "dist/**", ".nitely/**"],
    restoreMocks: true,
  },
});
