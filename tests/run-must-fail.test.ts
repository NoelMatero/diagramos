/**
 * A measurement run that could not check must say so, and fail (Fonseca 2017,
 * recommendation 1).
 *
 * On 2026-11-22 a new machine had no Rust dependencies downloaded. The
 * checker builds offline, so every Rust build failed and the Rust compiler
 * answered nothing; `measure:compiler-true --language=rust` printed 0 pairs
 * and exited 0, and a bench run would have printed a smaller Rust score that
 * looked like a real one.
 *
 * Pinned here, on numbers rather than on a machine: what a failed build says
 * about itself, how a run adds up which compilers answered, when that makes a
 * run NOT VALID, how canaries are judged, when a correctness run measured
 * nothing, and how a pause is told from a busy process.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildFailureReason, compileCrates } from "../src/engine/referee-rustc";
import { PauseClock, pausesLine, powerLogSleeps } from "../scripts/lib/run-pauses";
import {
  CompilerTally, judgeCanaries, judgeCompilerTrue, type Canary, type CanaryAnswer,
} from "../scripts/lib/run-validity";

const HAS_CARGO = spawnSync("cargo", ["--version"]).status === 0;

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("why a Rust build failed", () => {
  it("names missing dependencies, the failure a fresh machine hits", () => {
    const log = "error: no matching package named `itoa` found\nlocation searched: crates.io index\n"
      + "note: offline mode (via `--offline`) can sometimes cause surprising resolution failures\n";
    expect(buildFailureReason(log)).toContain("dependencies are not downloaded");
    expect(buildFailureReason("error: failed to download `memchr v2.7.4`\n")).toContain("cargo fetch");
  });

  it("otherwise quotes the first error line", () => {
    const log = "   Compiling x v0.1.0\nwarning: unused\nerror[E0425]: cannot find value `not_a_value` in this scope\n";
    expect(buildFailureReason(log)).toBe("the build failed: error[E0425]: cannot find value `not_a_value` in this scope");
    expect(buildFailureReason(undefined)).toBe("the build failed and left no log");
  });

  describe.skipIf(!HAS_CARGO)("on a real crate", () => {
    function crate(dependency: boolean): { repo: string; cache: string; home: string } {
      const repo = mkdtempSync(path.join(tmpdir(), "run-must-fail-"));
      const cache = mkdtempSync(path.join(tmpdir(), "rustc-cache-"));
      const home = mkdtempSync(path.join(tmpdir(), "cargo-home-"));
      dirs.push(repo, cache, home);
      writeFileSync(path.join(repo, "Cargo.toml"), "[package]\nname = \"canary\"\nversion = \"0.1.0\"\nedition = \"2021\"\n"
        + `${dependency ? "[dependencies]\nitoa = \"1\"\n" : ""}[workspace]\n`);
      mkdirSync(path.join(repo, "src"));
      writeFileSync(path.join(repo, "src/lib.rs"), "pub fn helper() -> u8 {\n    1\n}\n");
      return { repo, cache, home };
    }

    it("says the dependencies are missing when they were never downloaded, every time it is asked", async () => {
      const { repo, cache, home } = crate(true);
      const saved = process.env.CARGO_HOME;
      process.env.CARGO_HOME = home;
      try {
        for (let ask = 0; ask < 2; ask += 1) {
          const crates = await compileCrates(repo, ["src/lib.rs"], { until: Date.now() + 120_000, cacheDir: cache });
          expect(crates.answered).toBe(false);
          expect(crates.crates).toEqual([{ manifest: "Cargo.toml", built: false, why: expect.stringContaining("dependencies are not downloaded") }]);
        }
      } finally {
        if (saved === undefined) delete process.env.CARGO_HOME; else process.env.CARGO_HOME = saved;
      }
    }, 180_000);

    it("says it built a crate that built", async () => {
      const { repo, cache } = crate(false);
      const crates = await compileCrates(repo, ["src/lib.rs"], { until: Date.now() + 120_000, cacheDir: cache });
      expect(crates.crates).toEqual([{ manifest: "Cargo.toml", built: true }]);
    }, 180_000);
  });
});

describe("which compilers answered, counted over a run", () => {
  const healthy = () => {
    const tally = new CompilerTally();
    tally.add("clap", { silent: [], nothingToAsk: false, questions: { rust: { asked: 30, answered: 20 }, rustc: { asked: 12, answered: 12 } },
      crates: [{ manifest: "clap_builder/Cargo.toml", built: true }] });
    tally.add("flask", { silent: [], nothingToAsk: false, questions: { python: { asked: 40, answered: 31 } } });
    tally.add("flask", { silent: [], nothingToAsk: true });
    return tally;
  };

  it("states them per language, including the one never asked", () => {
    const lines = healthy().lines(["ts", "python", "rust"]).join("\n");
    expect(lines).toContain("the TypeScript compiler was never asked");
    expect(lines).toContain("pyright answered 31 of 40 questions in 1 project");
    expect(lines).toContain("rust-analyzer answered 20 of 30 questions in 1 project; the Rust compiler built 1 of 1 crates");
    expect(healthy().problems(["ts", "python", "rust"])).toEqual([]);
  });

  it("is NOT VALID when no Rust crate built, and says why (2026-11-22)", () => {
    const tally = new CompilerTally();
    const why = "its dependencies are not downloaded (the build is offline): run `cargo fetch` in it";
    for (const project of ["clap", "regex"]) {
      tally.add(project, { silent: ["rustc"], nothingToAsk: false, questions: { rust: { asked: 30, answered: 20 }, rustc: { asked: 9, answered: 0 } },
        crates: [{ manifest: "Cargo.toml", built: false, why }] });
    }
    const problems = tally.problems(["rust"]);
    expect(problems).toEqual([`rust: the Rust compiler built none of the 2 crates it was asked for -- ${why}`]);
    expect(tally.lines(["rust"]).join("\n")).toContain(`not built: clap Cargo.toml: ${why}`);
  });

  it("is NOT VALID when a server was asked plenty and answered nothing, but not on a handful", () => {
    const tally = new CompilerTally();
    tally.add("flask", { silent: ["python"], nothingToAsk: false, questions: { python: { asked: 3, answered: 0 } } });
    expect(tally.problems(["python"])).toEqual([]);
    tally.add("httpx", { silent: ["python"], nothingToAsk: false, questions: { python: { asked: 40, answered: 0 } } });
    expect(tally.problems(["python"])).toEqual(["python: pyright was asked 43 questions and answered none -- it did not start in 2 projects"]);
    // Only the languages the run scored are judged.
    expect(tally.problems(["rust"])).toEqual([]);
  });

  it("keeps a crate built once as built, and survives a trip through a child process", () => {
    const tally = new CompilerTally();
    tally.add("clap", { silent: [], nothingToAsk: false, crates: [{ manifest: "Cargo.toml", built: true }] });
    tally.add("clap", { silent: [], nothingToAsk: false, crates: [{ manifest: "Cargo.toml", built: false, why: "still building when the check's time ran out" }] });
    const copy = new CompilerTally();
    copy.merge(JSON.parse(JSON.stringify(healthy().toJSON())));
    copy.merge(JSON.parse(JSON.stringify(tally.toJSON())));
    expect(copy.cratesOf("clap").every((crate) => crate.built)).toBe(true);
    expect(copy.count("python")).toEqual({ asked: 40, answered: 31 });
    expect(copy.checks).toBe(5);
  });
});

describe("canaries", () => {
  const canary = (language: string, needs: string): Canary => ({
    project: "clap", claim: "c1", language, needs, arrow: "@calls a -> b",
  });

  it("pass when every one goes red", () => {
    const answers: CanaryAnswer[] = [
      { canary: canary("rust", "rustc"), outcome: "red", detail: "calls-refuted" },
      { canary: canary("tsx", "typescript"), outcome: "red", detail: "calls-refuted" },
    ];
    expect(judgeCanaries(answers, new CompilerTally())).toEqual({
      failed: [], lines: ["rust    1 of 1 canaries red", "ts      1 of 1 canaries red"],
    });
  });

  it("fail the language whose canary did not go red, with the build's own reason", () => {
    const tally = new CompilerTally();
    tally.add("clap", { silent: ["rustc"], nothingToAsk: false, crates: [{ manifest: "clap_builder/Cargo.toml", built: false, why: "its dependencies are not downloaded" }] });
    const verdict = judgeCanaries([
      { canary: canary("rust", "rustc"), outcome: "not sure", detail: "unconfirmed: claim-not-checked" },
      { canary: canary("python", "python"), outcome: "red", detail: "calls-refuted" },
    ], tally);
    expect(verdict.failed).toEqual(["rust"]);
    const text = verdict.lines.join("\n");
    expect(text).toContain("rust    COULD NOT CHECK: 1 of 1 canaries did not go red");
    expect(text).toContain("the Rust compiler could not build clap_builder/Cargo.toml: its dependencies are not downloaded");
  });

  it("say pyright answered nothing when that is what happened, and name a canary the key lost", () => {
    const tally = new CompilerTally();
    tally.add("clap", { silent: [], nothingToAsk: false, questions: { python: { asked: 7, answered: 0 } } });
    const verdict = judgeCanaries([
      { canary: canary("python", "python"), outcome: "not sure", detail: "x" },
      { canary: { ...canary("python", "python"), claim: "gone" }, outcome: "missing", detail: "not in the key" },
    ], tally);
    const text = verdict.lines.join("\n");
    expect(text).toContain("pyright answered none of the 7 questions");
    expect(text).toContain("no longer has claim gone");
  });
});

describe("a correctness run that measured nothing", () => {
  it("fails on 0 pairs, the 2026-11-22 Rust run", () => {
    const verdict = judgeCompilerTrue("rust", ["anyhow", "clap", "json", "regex", "ripgrep"].map((project) => ({
      project, pairs: 0, couldNotRun: "the Rust compiler built 0 of 1 crates: its dependencies are not downloaded",
    })), []);
    expect(verdict.valid).toBe(false);
    expect(verdict.lines[0]).toContain("NOT VALID: rust gave 0 pairs in 5 projects");
  });

  it("names one odd project out of five and fails on two", () => {
    const projects = (bad: number) => ["anyhow", "clap", "json", "regex", "ripgrep"].map((project, index) => ({
      project, pairs: index < bad ? 0 : 1000,
    }));
    const one = judgeCompilerTrue("rust", projects(1), []);
    expect(one.valid).toBe(true);
    expect(one.lines).toEqual(["anyhow: measured nothing -- the compiler gave 0 pairs"]);
    expect(judgeCompilerTrue("rust", projects(1), ["clap (exit 1): boom"]).valid).toBe(false);
    expect(judgeCompilerTrue("rust", projects(0), []).valid).toBe(true);
  });
});

describe("pauses", () => {
  it("are a late tick with the process idle, not one held up by its own work", () => {
    const clock = new PauseClock({ tickMs: 5_000, minPauseMs: 30_000 }, 0, 0);
    expect(clock.look(5_000, 100)).toBeUndefined();
    // 79 s late and 0.2 s of CPU: the process did not run.
    expect(clock.look(89_000, 300)).toEqual({ at: 10_000, ms: 79_000 });
    // 40 s late and 39 s of CPU: a long synchronous check, not a pause.
    expect(clock.look(134_000, 39_300)).toBeUndefined();
  });

  it("are read from the Mac's power log, inside the run only", () => {
    const log = [
      "2026-11-15 16:40:01 +0200 Sleep               \tEntering Sleep state due to 'Idle Sleep':TCPKeepAlive=active Using AC (Charge:100%) 79 secs",
      "2026-11-15 16:41:20 +0200 Wake                \tWake from Deep Idle [CDNVA] : due to smc.sysState.Wake Using AC (Charge:100%)",
      "2026-11-15 18:00:00 +0200 Sleep               \tEntering Sleep state due to 'Maintenance Sleep':TCPKeepAlive=active Using AC (Charge:100%) 56 secs",
    ].join("\n");
    const sleeps = powerLogSleeps(log, Date.parse("2026-11-15T16:35:00+02:00"), Date.parse("2026-11-15T16:58:35+02:00"));
    expect(sleeps).toEqual([{ at: Date.parse("2026-11-15T16:40:01+02:00"), why: "Idle Sleep", seconds: 79 }]);
    expect(pausesLine([], [])).toBe("pauses: none seen; power log: no sleep during the run");
    expect(pausesLine([{ at: sleeps[0]!.at, ms: 79_000 }], sleeps)).toMatch(/^pauses: 1 -- 79s at \S+; this process did not run.*power log: 1 sleep during the run \(Idle Sleep at \S+ for 79s\)\. Servers may have timed out/);
  });
});
