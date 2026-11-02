import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
// Times show in the viewer's own time zone (i18n useFormatters); the tests pin it to UTC so
// their expected text is the same on every machine.
process.env.TZ = "UTC";
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
});
