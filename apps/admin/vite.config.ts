import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  build: {
    // The browsers the stylesheet is compiled for: Vite's baseline-widely-available set with
    // Chrome and Edge raised from 111 to 120, the first versions with :dir(). Every target
    // supports :dir(), so Lightning CSS keeps direction selectors as written. For an older
    // target it rewrites :dir(rtl) into a list of right-to-left :lang() values, which follows
    // the language rather than the direction: wrong for mixed content and dir="auto" fields.
    // tests/cssBuild.test.ts builds a probe stylesheet with this config and checks the output.
    cssTarget: ["chrome120", "edge120", "firefox114", "safari16.4", "ios16.4"],
  },
  server: { fs: { strict: true, allow: ["."] } },
});
