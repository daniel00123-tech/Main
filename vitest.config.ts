import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"]
  },
  resolve: {
    alias: [
      {
        find: /^@\/generated\/(.*)$/,
        replacement: new URL("./generated/$1", import.meta.url).pathname
      },
      {
        find: "@",
        replacement: new URL("./src", import.meta.url).pathname
      }
    ]
  }
});
