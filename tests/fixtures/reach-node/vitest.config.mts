/**
 * The fixture suite the Node referee is tested against: one file per call shape
 * (`src/lib.ts`), run the way a corpus repository is run.
 *
 * Not part of `npm test`'s own run -- the root `vitest.config.ts` excludes it,
 * and `tests/reach-trace-node.test.ts` drives it from outside.
 */
import { defineConfig } from "vitest/config";

import { reachTrace } from "../../../scripts/lib/reach-trace-plugin.mjs";

export default defineConfig({
  plugins: [reachTrace({ root: process.env.REACH_ROOT! })],
  test: {
    root: import.meta.dirname,
    include: ["*.spec.ts"],
    setupFiles: ["../../../scripts/lib/reach-trace-node.mjs"],
  },
});
