/**
 * Grammars load once for the whole test run.
 *
 * The engine is synchronous below `initEngine`, which is what lets a drift
 * check be called from the middle of a turn. The cost of that is one await
 * somewhere near the entry point, and for tests that is here.
 */
import { beforeAll, afterAll } from "vitest";
import { initEngine, resetEngineCache } from "../src/engine/parse";
import { resetBodyCache } from "../src/engine/body";

beforeAll(async () => { await initEngine(); });
afterAll(() => { resetEngineCache(); resetBodyCache(); });
