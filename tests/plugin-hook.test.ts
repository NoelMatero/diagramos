/**
 * The hook the plugin ships, which decides whether the drift check runs for
 * anyone other than this repository.
 *
 * It was opt-in for most of this project's life, because a plugin hook fires in
 * every project someone installs into and most have no diagrams. What ships
 * instead is a guard that exits before starting node, and this file exists to
 * pin that guard: if it ever stops firing, every install pays ~260ms of npx and
 * node startup on every turn for nothing, and the reason the hook can be shipped
 * at all is gone.
 *
 * The check itself is covered by check-drift-cli.test.ts. What is covered here
 * is only the shell around it, tested by putting a fake `npx` first on PATH --
 * so these assertions are about whether the real command would have been
 * launched, and never about what it would have said.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CONFIG_FILE, DEFAULT_DIAGRAM_DIR } from "../src/engine/config";

const REPO = path.resolve(__dirname, "..");
const HOOK = path.join(REPO, "hooks/drift.sh");
const MANIFEST = path.join(REPO, ".claude-plugin/plugin.json");

let sandbox: string;
let project: string;
let log: string;

/**
 * Stands in for npx, recording its arguments. `exit 0` matters: a fake that
 * failed would make the swallow-a-launch-failure case below pass for the wrong
 * reason.
 */
function fakeNpx(body = 'echo "$*" >> "$LOG"\nexit 0'): void {
  const bin = path.join(sandbox, "bin");
  mkdirSync(bin, { recursive: true });
  const file = path.join(bin, "npx");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

/** Runs the hook the way Claude Code does, with a stripped environment. */
function runHook(projectDir = project): { code: number; invoked: string[] } {
  let code = 0;
  try {
    execFileSync("sh", [HOOK], {
      env: {
        PATH: `${path.join(sandbox, "bin")}:/usr/bin:/bin`,
        CLAUDE_PROJECT_DIR: projectDir,
        LOG: log,
      },
      stdio: "pipe",
    });
  } catch (error) {
    code = (error as { status?: number }).status ?? -1;
  }
  let invoked: string[] = [];
  try {
    invoked = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    invoked = [];
  }
  return { code, invoked };
}

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "plugin-hook-"));
  project = path.join(sandbox, "project");
  log = path.join(sandbox, "invoked.log");
  mkdirSync(project, { recursive: true });
  fakeNpx();
});

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

describe("the hook the plugin ships", () => {
  it("does not start node in a project with no diagrams", () => {
    const { code, invoked } = runHook();
    expect(invoked).toEqual([]);
    // Zero, not merely quiet: Claude Code renders any non-zero hook as
    // "Stop hook error: Failed", so a project with no diagrams would see an
    // error every turn forever.
    expect(code).toBe(0);
  });

  it("runs the check when the default diagram directory exists", () => {
    mkdirSync(path.join(project, DEFAULT_DIAGRAM_DIR), { recursive: true });
    const { code, invoked } = runHook();
    expect(invoked).toHaveLength(1);
    expect(invoked[0]).toContain("drift --hook");
    expect(code).toBe(0);
  });

  it("runs the check when only a config file says where the diagrams are", () => {
    /*
     * The half of the guard that is easy to leave out, and the reason both tests
     * are there. The diagram directory is configurable, so a guard that only
     * looked at the default would silently skip every project that moved it --
     * checking nothing while appearing to work, which is the exact failure the
     * drift check exists to catch.
     */
    writeFileSync(path.join(project, CONFIG_FILE), '{"diagrams":"design/boards"}\n');
    const { invoked } = runHook();
    expect(invoked).toHaveLength(1);
  });

  it("stays quiet when npx cannot run at all", () => {
    mkdirSync(path.join(project, DEFAULT_DIAGRAM_DIR), { recursive: true });
    fakeNpx('echo "npm is broken" >&2\nexit 1');
    /*
     * A non-zero status here is never a finding -- `--hook` exits 0 once it has
     * delivered its notice -- so it means npx could not fetch or run the package:
     * offline, a broken cache, a half-installed npm. Passing that through would
     * put "Stop hook error: Failed" on every turn of a project that simply has no
     * network, and that is how a check gets switched off.
     */
    expect(runHook().code).toBe(0);
  });

  it("gives up quietly when the project directory does not exist", () => {
    expect(runHook(path.join(sandbox, "nowhere")).code).toBe(0);
    expect(runHook(path.join(sandbox, "nowhere")).invoked).toEqual([]);
  });
});

describe("the hook manifest", () => {
  const hooks = JSON.parse(readFileSync(path.join(REPO, "hooks/hooks.json"), "utf8"));

  it("registers one Stop hook that runs the shipped script", () => {
    const stop = hooks.hooks.Stop;
    expect(stop).toHaveLength(1);
    // Stop is documented to ignore matchers while the plugin-dev validator
    // rejects a hook without one, so "*" is what satisfies both.
    expect(stop[0].matcher).toBe("*");
    expect(stop[0].hooks[0].command).toContain("hooks/drift.sh");
    // Through `sh`, so a copy into the plugin cache that drops the executable
    // bit still works.
    expect(stop[0].hooks[0].command).toMatch(/^sh /);
  });

  it("pins the same version everywhere it is written down", () => {
    /*
     * Three places, and nothing else checks that they agree. The pin exists
     * because installing a plugin copies files into a cache without running npm
     * install, so a cached plugin must not pick up a newer server than it shipped
     * against -- and a pin that has drifted is worse than none, because it points
     * confidently at the wrong version.
     */
    const version = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).version;
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    expect(manifest.version).toBe(version);
    expect(JSON.stringify(manifest.mcpServers.diagramos.args)).toContain(`diagramos@${version}`);
    expect(readFileSync(HOOK, "utf8")).toContain(`diagramos@${version}`);
  });
});
