/**
 * The installer that makes the deeper arrow check on by default.
 *
 * Driven with fake `graphify` / `uv` / `pipx` executables on a controlled PATH,
 * so the tests prove which command it would run without ever installing
 * anything. What matters here is restraint: it must not install when graphify
 * is already there, must not reach for a tool the machine does not have, and
 * must never fail an npm install.
 */

import { chmodSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts", "ensure-graphify.mjs");

let bin: string;
let log: string;

beforeEach(() => {
  bin = mkdtempSync(path.join(os.tmpdir(), "ensure-graphify-"));
  log = path.join(bin, "calls.log");
});

afterEach(() => {
  rmSync(bin, { recursive: true, force: true });
});

/**
 * Write a fake executable that records how it was called.
 *
 * `--version` always answers 0 -- that probe is how the script decides a tool
 * exists at all, so a tool that fails it is simply an absent tool. Every other
 * invocation (the install itself) exits with `installStatus`.
 */
function fake(name: string, installStatus = 0): void {
  const file = path.join(bin, name);
  writeFileSync(
    file,
    `#!/bin/sh\necho "${name} $*" >> "${log}"\n`
    + `case "$1" in --version) exit 0 ;; esac\nexit ${installStatus}\n`,
  );
  chmodSync(file, 0o755);
}

/**
 * An installer that actually works: installing puts a `graphify` on the PATH,
 * which is what lets the success path be tested end to end.
 */
function workingInstaller(name: string): void {
  const file = path.join(bin, name);
  writeFileSync(
    file,
    `#!/bin/sh\necho "${name} $*" >> "${log}"\n`
    + `case "$1" in --version) exit 0 ;; esac\n`
    + `printf '#!/bin/sh\\necho "graphify $*" >> "${log}"\\nexit 0\\n' > "${path.join(bin, "graphify")}"\n`
    + `chmod 755 "${path.join(bin, "graphify")}"\nexit 0\n`,
  );
  chmodSync(file, 0o755);
}

function calls(): string[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
}

function ensure(env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      // A PATH holding only our fakes plus the system directories node needs.
      PATH: `${bin}:/usr/bin:/bin`,
      ...env,
    },
  });
}

describe("ensure-graphify", () => {
  it("does nothing when graphify already answers", () => {
    fake("graphify");
    fake("uv");
    const result = ensure();
    expect(result.status).toBe(0);
    expect(calls()).toEqual(["graphify --version"]);
    expect(result.stderr).toBe("");
  });

  it("installs with uv when graphify is missing", () => {
    workingInstaller("uv");
    const result = ensure();
    expect(result.status).toBe(0);
    expect(calls()).toContain("uv tool install graphifyy");
    expect(result.stderr).toContain("graphify ready");
  });

  it("falls back to pipx when uv is absent", () => {
    workingInstaller("pipx");
    const result = ensure();
    expect(result.status).toBe(0);
    expect(calls()).toContain("pipx install graphifyy");
    expect(calls().some((call) => call.startsWith("uv "))).toBe(false);
  });

  it("prefers uv over pipx when both exist", () => {
    workingInstaller("uv");
    fake("pipx");
    ensure();
    expect(calls()).toContain("uv tool install graphifyy");
    expect(calls().some((call) => call.startsWith("pipx "))).toBe(false);
  });

  it("stays quiet and succeeds when there is no installer at all", () => {
    const result = ensure();
    expect(result.status).toBe(0);
    expect(calls()).toEqual([]);
    expect(result.stderr).toBe("");
  });

  it("succeeds even when the install fails, and says so", () => {
    fake("uv", 1);
    const result = ensure();
    expect(result.status).toBe(0);
    expect(calls()).toContain("uv tool install graphifyy");
    expect(result.stderr).toContain("could not install graphify");
  });

  it("succeeds when the installer claims victory but graphify still is not there", () => {
    fake("uv", 0);
    const result = ensure();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("could not install graphify");
  });

  it("skips entirely when asked to", () => {
    workingInstaller("uv");
    const result = ensure({ DIAGRAMOS_SKIP_GRAPHIFY: "1" });
    expect(result.status).toBe(0);
    expect(calls()).toEqual([]);
  });

  it("skips in CI, where a per-machine tool install is not wanted", () => {
    workingInstaller("uv");
    const result = ensure({ CI: "true" });
    expect(result.status).toBe(0);
    expect(calls()).toEqual([]);
  });
});
