import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    /*
     * A timeout here catches a hang. It is not a performance budget.
     *
     * The default is five seconds, and this suite has two kinds of test that
     * cannot promise that under load: about sixty of them spawn `tsx` as a
     * subprocess to drive the real CLI, and one loads a 13 MB Excalidraw bundle
     * through vitest's transform. Measured on an idle laptop, a CLI test takes
     * ~530 ms and the bundle load 2.9-7.9 s; measured while twenty test files
     * compete for the cores, both stretch far enough to cross five seconds
     * sometimes and not others.
     *
     * That produced exactly the worst kind of failure -- a red suite that goes
     * green when you rerun it, teaching everyone to rerun it. Thirty seconds is
     * chosen so that nothing but a genuine hang can reach it, and the cost of
     * being wrong is that a hung test takes thirty seconds to say so.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      reporter: ["text", "html"]
    }
  }
});
