/**
 * A rust-analyzer that is gone before the check starts listening for it.
 *
 * CI has rustup but not the rust-analyzer component, so `rust-analyzer` there
 * is rustup's proxy: it prints "Unknown binary" and exits within milliseconds.
 * `createRustAnalyzerReferee` races the handshake against that exit -- but it
 * started listening for the exit only after loading the JSON-RPC library, and
 * on a first check that load is slow enough for the process to be gone
 * unheard. The handshake then waited forever, and `engine-referee-live`'s
 * "falls back to the text reading" test timed out on every CI run after #342.
 *
 * A laptop almost never loses that race, so this does not wait for it: the
 * library is made slow to load, every time, and the process is dead long
 * before it arrives. `vi.mock` is per file, which is why this is its own.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRustAnalyzerReferee } from "../src/engine/referee-rust-lsp";

vi.mock("vscode-jsonrpc/node", async (original) => {
  await new Promise((resolve) => { setTimeout(resolve, 500); });
  return original();
});

describe.skipIf(process.platform === "win32")("a rust-analyzer that exits before the check listens", () => {
  let repo: string;
  let savedPath: string | undefined;
  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "referee-rust-exit-race-"));
    writeFileSync(path.join(repo, "Cargo.toml"), "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\n");
    const bin = path.join(repo, ".fake-bin");
    mkdirSync(bin);
    const stub = path.join(bin, "rust-analyzer");
    writeFileSync(stub,
      "#!/bin/sh\n"
      + "echo \"error: Unknown binary 'rust-analyzer' in official toolchain 'stable'.\" >&2\n"
      + "exit 1\n");
    chmodSync(stub, 0o755);
    savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(repo, { recursive: true, force: true });
  });

  it("refuses at once instead of waiting forever for a handshake", async () => {
    const started = Date.now();
    const outcome = await Promise.race([
      createRustAnalyzerReferee(repo).then(
        () => "started",
        (error: Error) => error.message,
      ),
      new Promise<string>((resolve) => { setTimeout(() => resolve("still waiting"), 5_000).unref(); }),
    ]);

    expect(outcome).toContain("rust-analyzer exited before answering");
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);
});
