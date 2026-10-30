import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Unit tests sit next to the code they cover; integration tests live in test/.
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    restoreMocks: true,
  },
});
