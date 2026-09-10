import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

export interface ProbeSite { id: number; start: number; end: number }

/** One diagnostic from `cargo check --message-format=json`, trimmed to what is read. */
export interface RustcMessage {
  level: string;
  code?: { code: string } | null;
  message: string;
  spans: Array<{ file_name: string; line_start: number; label: string | null; is_primary: boolean }>;
}

export interface CompilerAnswer {
  /** The receiver's type, spelled the way rustc spelled it. */
  printed: string;
  /** rustc's own word for what that type is: `reference`, `struct`, `type parameter`... */
  kind: string;
  /** The declaration of the type once references are peeled off; 0-based line. */
  declaration?: { file: string; line: number };
}

const EXISTS_FOR = /^the method `(__q[a-z]{6})` exists for ([a-z ]+?) `(.+)`, but its trait bounds were not satisfied$/s;
const NOT_FOUND_FOR = /^no method named `(__q[a-z]{6})` found for ([a-z ]+?) `(.+)` in the current scope$/s;

export interface RustcSite {
  id: number;
  /** Absolute path of the source file, inside the tree being measured. */
  file: string;
  start: number;
  end: number;
}

export interface RustcBuild {
  /** The cargo root, in the tree measured. */
  root: string;
  /** Errors from building the tree as it is, before any probe. Not zero means
   *  the compiler's answers there are a lower bound. */
  baselineErrors: number;
  /** cargo itself could not run the build: no toolchain, a dependency not in
   *  the offline cache, a manifest it rejects. No answers come from this root. */
  failure?: string;
}

export interface RustcReading {
  answers: Map<number, CompilerAnswer>;
  builds: RustcBuild[];
  /**
   * Whether the toolchain carries the standard library's source. Without it
   * rustc names a `std` type and points at no declaration, so every such answer
   * is unchecked for a reason that is the machine's, not the code's.
   */
  stdSource: boolean;
  /** Probed builds run: at most two per package -- see `askRustc`. */
  probedBuilds: number;
  /** Packages cargo would not list or build on their own, with its reason. */
  packageFailures: string[];
  /** Sites given two different declarations by two targets compiling one file
   *  under different `cfg`s. The first is kept. */
  conflicts: number;
  version: string;
}

/** Never copied, never read: build output, history, and JavaScript's equivalent. */
const COPY_SKIP = new Set(["target", ".git", "node_modules"]);

/**
 * Ask the compiler what every site's receiver is, by building a probed copy.
 *
 * **The tree is never written to.** It is copied, probes go into the copy, and
 * cargo builds the copy into a target directory of its own -- so a
 * rust-analyzer running against the real tree, and the user's own `target/`,
 * are both left alone.
 *
 * **One package at a time, because every probe is a compile error.** A crate
 * with errors produces no metadata, so nothing that depends on it is ever
 * type-checked. Probing a whole workspace at once answers for the crates at the
 * bottom of the graph and nothing above them. A first cut repeated the build,
 * restoring every file that had answered -- and lost unit tests wholesale: a
 * crate's own code builds without its dev-dependencies and its tests do not,
 * so the file answered, was restored, and its test module was never asked
 * again. ripgrep's printer lost 923 of 1,246 sites that way.
 *
 * So each package in the tree is built alone (`cargo check -p`) with only its
 * own files probed. Everything it depends on, dev-dependencies included, is
 * unprobed and compiles clean. Its library fails on its probes and its unit
 * tests still build, because they compile the library's files themselves. A
 * second build probes only what did not answer, which leaves the library clean
 * enough for the package's binaries and integration tests to build against --
 * they link the library and were blocked by it the first time.
 *
 * `--offline` because a measurement should not reach the network, and
 * `--ignore-rust-version` because a pinned corpus may ask for a newer toolchain
 * than the machine has for reasons that have nothing to do with typing.
 */
export async function askRustc(
  tree: string,
  roots: string[],
  sites: RustcSite[],
  options: { workDir?: string } = {},
): Promise<RustcReading> {
  const realTree = realpathSync(tree);
  const workDir = options.workDir ?? path.join(
    os.tmpdir(), "diagramos-rustc-referee",
    `${path.basename(realTree)}-${createHash("sha1").update(realTree).digest("hex").slice(0, 8)}`,
  );
  mkdirSync(workDir, { recursive: true });
  const realWork = realpathSync(workDir);
  const copy = path.join(realWork, "tree");
  // Kept between runs on purpose: dependencies are compiled once, not per run.
  const targetDir = path.join(realWork, "target");

  rmSync(copy, { recursive: true, force: true });
  cpSync(realTree, copy, {
    recursive: true,
    filter: (source) => source === realTree || !COPY_SKIP.has(path.basename(source)),
  });

  const inCopy = (file: string) => path.join(copy, path.relative(realTree, file));
  const fromCopy = (file: string) =>
    file.startsWith(copy + path.sep) ? path.join(realTree, file.slice(copy.length + 1)) : file;
  const inside = (file: string, directory: string) => file === directory || file.startsWith(directory + path.sep);

  const byFile = new Map<string, RustcSite[]>();
  const known = new Set<number>();
  for (const site of sites) {
    const file = realpathSync(site.file);
    const list = byFile.get(file) ?? [];
    list.push(site);
    byFile.set(file, list);
    known.add(site.id);
  }
  const originals = new Map([...byFile.keys()].map((file) => [file, readFileSync(file, "utf8")]));

  const builds: RustcBuild[] = [];
  const packageFailures: string[] = [];
  /** Keyed by the package's directory in the copy. */
  const packages = new Map<string, CargoPackage & { cwd: string }>();
  for (const root of roots) {
    const cwd = inCopy(realpathSync(root));
    const run = await runCargo(cwd, targetDir, ["--workspace"]);
    builds.push({
      root,
      baselineErrors: run.messages.filter(isRealError).length,
      ...(run.failure ? { failure: run.failure } : {}),
    });
    if (run.failure) continue;
    const listed = cargoPackages(cwd);
    if ("failure" in listed) {
      packageFailures.push(`${path.relative(copy, cwd) || "."}: ${listed.failure}`);
      continue;
    }
    // Path packages only -- a registry dependency's source is not in the tree.
    for (const one of listed.packages) {
      if (inside(one.dir, copy) && !packages.has(one.dir)) packages.set(one.dir, { ...one, cwd });
    }
  }

  /* A file belongs to the innermost package directory that holds it. */
  const filesOf = new Map<string, string[]>();
  for (const file of byFile.keys()) {
    const owner = [...packages.keys()]
      .filter((directory) => inside(inCopy(file), directory))
      .sort((a, b) => b.length - a.length)[0];
    if (!owner) continue;
    filesOf.set(owner, [...(filesOf.get(owner) ?? []), file]);
  }

  const answers = new Map<number, CompilerAnswer>();
  const declarationOf = (answer: CompilerAnswer) =>
    answer.declaration ? `${answer.declaration.file}:${answer.declaration.line}` : `none:${answer.kind}`;
  let conflicts = 0;
  let probedBuilds = 0;

  for (const [directory, files] of [...filesOf.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const pkg = packages.get(directory)!;
    for (let pass = 0; pass < 2; pass++) {
      const waiting = files.map((file) => [file, byFile.get(file)!.filter((site) => !answers.has(site.id))] as const);
      if (waiting.every(([, list]) => list.length === 0)) break;
      for (const [file, list] of waiting) {
        const source = originals.get(file)!;
        writeFileSync(inCopy(file), list.length > 0 ? probeSource(source, list) : source);
      }
      const before = answers.size;
      const run = await runCargo(pkg.cwd, targetDir, ["-p", pkg.id]);
      probedBuilds += 1;
      if (run.failure) {
        packageFailures.push(`${pkg.name}: ${run.failure}`);
        break;
      }
      for (const message of run.messages) {
        const read = readProbeAnswer(
          message, (name) => fromCopy(path.isAbsolute(name) ? name : path.resolve(pkg.cwd, name)));
        if (!read || !known.has(read.id)) continue;
        const already = answers.get(read.id);
        if (!already) answers.set(read.id, read.answer);
        else if (declarationOf(already) !== declarationOf(read.answer)) conflicts += 1;
      }
      // Nothing new means a second build would see the same thing.
      if (answers.size === before) break;
    }
    for (const file of files) writeFileSync(inCopy(file), originals.get(file)!);
  }

  let version = "unknown";
  try { version = execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(); } catch { /* recorded as unknown */ }
  return { answers, builds, probedBuilds, packageFailures, conflicts, version, stdSource: toolchainHasStdSource() };
}

interface CargoPackage { id: string; name: string; dir: string }

/**
 * Every package cargo resolves from `cwd` whose source is a path, not a registry.
 *
 * `--filter-platform` is not an optimisation. Unfiltered, `cargo metadata`
 * resolves the dependencies of every target platform, and offline that fails on
 * the first one this machine never fetched: ripgrep stops at Android's
 * `android_system_properties`, anyhow at Windows' `r-efi`. The build only ever
 * compiles for the host, so the host is the graph worth listing.
 */
function cargoPackages(cwd: string): { packages: CargoPackage[] } | { failure: string } {
  const host = (() => {
    try { return /^host: (.+)$/m.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1]; }
    catch { return undefined; }
  })();
  const listed = spawnSync("cargo", [
    "metadata", "--format-version", "1", "--offline", ...(host ? ["--filter-platform", host] : []),
  ], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (listed.status !== 0) {
    return { failure: listed.stderr.split("\n").find((line) => line.startsWith("error")) ?? `cargo metadata exited ${listed.status}` };
  }
  const metadata = JSON.parse(listed.stdout) as {
    packages: Array<{ id: string; name: string; manifest_path: string; source: string | null }>;
  };
  return {
    packages: metadata.packages
      .filter((one) => one.source === null)
      .map((one) => ({ id: one.id, name: one.name, dir: path.dirname(one.manifest_path) })),
  };
}

/**
 * Whether a sysroot carries the standard library's source, where rustup's
 * `rust-src` component installs it.
 *
 * Found by CI rather than by design: GitHub's runner has rustup and cargo but
 * not this component, so rustc typed `Vec` there and pointed at nothing, and a
 * test expecting `vec/mod.rs` failed on that machine alone.
 */
export function hasStdSource(sysroot: string): boolean {
  return existsSync(path.join(sysroot, "lib", "rustlib", "src", "rust", "library"));
}

/**
 * `hasStdSource`, for the sysroot the build will really use: asked of `rustc`
 * with the flags cargo passes it, since `--sysroot` in `RUSTFLAGS` moves it.
 */
function toolchainHasStdSource(): boolean {
  const encoded = process.env.CARGO_ENCODED_RUSTFLAGS;
  const flags = encoded !== undefined && encoded !== ""
    ? encoded.split("\x1f")
    : (process.env.RUSTFLAGS ?? "").split(/\s+/).filter(Boolean);
  try {
    return hasStdSource(execFileSync("rustc", [...flags, "--print", "sysroot"], { encoding: "utf8" }).trim());
  } catch {
    return false;
  }
}

/** An error the code itself has, not the summary line cargo adds after it. */
function isRealError(message: RustcMessage): boolean {
  return message.level === "error" && !/^aborting due to/.test(message.message);
}

function runCargo(
  cwd: string,
  targetDir: string,
  selection: string[],
): Promise<{ messages: RustcMessage[]; failure?: string }> {
  return new Promise((resolve) => {
    const child = spawn("cargo", [
      "check", ...selection, "--all-targets", "--offline", "--ignore-rust-version",
      "--message-format=json",
    ], { cwd, env: { ...process.env, CARGO_TARGET_DIR: targetDir }, stdio: ["ignore", "pipe", "pipe"] });

    const messages: RustcMessage[] = [];
    let stderr = "";
    createInterface({ input: child.stdout }).on("line", (line) => {
      let entry: { reason?: string; message?: RustcMessage };
      try { entry = JSON.parse(line); } catch { return; }
      if (entry.reason !== "compiler-message" || !entry.message) return;
      // Kept to what is read: a probed corpus build is thousands of these, and
      // each carries its full rendered text.
      const { level, code, message, spans } = entry.message;
      messages.push({
        level, code, message,
        spans: spans.map(({ file_name, line_start, label, is_primary }) => ({ file_name, line_start, label, is_primary })),
      });
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-64_000); });
    child.on("error", (error) => resolve({ messages, failure: `cargo could not be started: ${error.message}` }));
    child.on("close", (code) => {
      // A failed build with compiler errors is a build. One with none is cargo
      // refusing before rustc ran, and its reason is on stderr.
      const refused = code !== 0 && !messages.some(isRealError);
      const reason = stderr.split("\n").find((line) => line.startsWith("error")) ?? `cargo exited ${code}`;
      resolve(refused ? { messages, failure: reason } : { messages });
    });
  });
}

export function readProbeAnswer(
  message: RustcMessage,
  resolveFile: (fileName: string) => string,
): { id: number; answer: CompilerAnswer } | undefined {
  /*
   * A type parameter has no impl for a blanket bound to fail on, so rustc says
   * the method is not there at all. The span it adds is the parameter in the
   * signature, which declares no type -- nothing is offered as a declaration.
   */
  const missing = NOT_FOUND_FOR.exec(message.message);
  if (missing) return { id: probeIdOf(missing[1]!)!, answer: { printed: missing[3]!, kind: missing[2]! } };
  const match = EXISTS_FOR.exec(message.message);
  if (!match) return undefined;
  const answer: CompilerAnswer = { printed: match[3]!, kind: match[2]! };
  /*
   * rustc labels every declaration an unsatisfied bound touches, and a type
   * that carries another -- `Box<dyn Fn()>` -- gets both, in no promised order.
   * The one wanted states the receiver's own type, references peeled, because
   * the bound is checked on each autoderef step and `&T` has no declaration.
   *
   * Two spellings of that label, both read: a type from another crate gets
   * `doesn't satisfy ...` alone, one declared in the crate being built gets
   * `method ... not found for this struct because it doesn't satisfy ...`.
   *
   * And one fallback, narrow on purpose. While a receiver's type still holds an
   * inference hole the label spells the whole type `_`, but the span is still
   * the declaration of the type the message names. Taken only when it is the one
   * declaration offered, so it can never pick between two.
   */
  const peeled = match[3]!.replace(/^(?:&(?:'\w+\s+)?(?:mut\s+)?)+/, "");
  const declarations = message.spans.filter((one) => !one.is_primary && one.label?.includes("doesn't satisfy `"));
  const declared = declarations.find((one) => one.label!.includes(`doesn't satisfy \`${peeled}: `))
    ?? (declarations.length === 1 && declarations[0]!.label!.includes("doesn't satisfy `_: ") ? declarations[0] : undefined);
  if (declared) answer.declaration = { file: resolveFile(declared.file_name), line: declared.line_start - 1 };
  return { id: probeIdOf(match[1]!)!, answer };
}

/**
 * Whether rustc and rust-analyzer are pointing at one type a macro declares.
 *
 * Such a type has two honest locations and neither tool is wrong. rustc names
 * the line inside the `macro_rules!` body that writes the declaration --
 * `pub struct $forward_iterator<'a, P>` for `core`'s `str::Split`,
 * `pub struct $atomic_type` for `AtomicUsize`, and for `lazy_static!` not a
 * `struct` line at all but the inner call that forwards `$N`. rust-analyzer
 * names the invocation that supplies the name: `struct Split;`,
 * `usize AtomicUsize`, `pub static ref ROUTES`.
 *
 * Two conditions, and the second is what keeps this from excusing a real
 * error: rustc's line has to use a macro metavariable, *and* rust-analyzer's
 * line has to name the very type rustc printed. Two answers that name the same
 * type are not two answers about different types, whatever files they sit in.
 */
export function declaredByMacro(rustcLine: string, raLine: string, printed: string): boolean {
  if (!/\$[A-Za-z_]\w*/.test(rustcLine)) return false;
  const head = printed.replace(/^(?:&(?:'\w+\s+)?(?:mut\s+)?)+/, "").split("<")[0]!.split("::").pop()!.trim();
  if (!/^[A-Za-z_]\w*$/.test(head)) return false;
  return new RegExp(`\\b${head}\\b`).test(raLine);
}

/**
 * Probe names are six letters, scrambled so that no two look alike -- and that
 * is a performance property, not a cosmetic one.
 *
 * For every method call that fails, rustc searches for a method with a similar
 * name to suggest. `__probe_17` and `__probe_183` are within its reach of each
 * other, and so is nearly every pair of numbered names, so each probe's error
 * searched every other probe: measured on rustc 1.93, 100 probes built in 1.6s,
 * 200 in 5.9s, 400 in 266s, and one ripgrep crate ran past half an hour. The
 * same builds with these names took 0.6s, 0.4s, 0.8s -- and 800 in 1.8s.
 *
 * Multiplying by a constant coprime to 26^6 is a bijection on that range, so
 * consecutive ids -- one file's sites -- land far apart and every name still
 * decodes to exactly one id.
 */
const NAME_SPACE = 26n ** 6n;
const SCRAMBLE = 2654435761n % NAME_SPACE;
const UNSCRAMBLE = (() => {
  // Extended Euclid: SCRAMBLE * UNSCRAMBLE = 1 (mod NAME_SPACE).
  let [a, b, x, y] = [SCRAMBLE, NAME_SPACE, 1n, 0n];
  while (b !== 0n) {
    const q = a / b;
    [a, b, x, y] = [b, a - q * b, y, x - q * y];
  }
  if (a !== 1n) throw new Error("probe name scramble is not invertible");
  return ((x % NAME_SPACE) + NAME_SPACE) % NAME_SPACE;
})();

/** The method a probe calls, which is how its error is traced back to its site. */
export function probeMethodName(id: number): string {
  let x = (BigInt(id) * SCRAMBLE) % NAME_SPACE;
  let letters = "";
  for (let i = 0; i < 6; i++) {
    letters += String.fromCharCode(97 + Number(x % 26n));
    x /= 26n;
  }
  return `__q${letters}`;
}

/** `probeMethodName`, backwards. */
export function probeIdOf(name: string): number | undefined {
  const match = /^__q([a-z]{6})$/.exec(name);
  if (!match) return undefined;
  let x = 0n;
  for (let i = 5; i >= 0; i--) x = x * 26n + BigInt(match[1]!.charCodeAt(i) - 97);
  return Number((x * UNSCRAMBLE) % NAME_SPACE);
}

function opening(id: number): string {
  return `({ trait __P${id} { fn ${probeMethodName(id)}(&self) {} } trait __Q${id} {} `
    + `impl<T: ?Sized + __Q${id}> __P${id} for T {} let __p = `;
}

function closing(id: number): string {
  return `; __p.${probeMethodName(id)}(); __p })`;
}

/**
 * Every probe in one pass over the original text, at original offsets.
 *
 * Receiver ranges nest rather than overlap -- `w.items` inside `w.items.iter()`
 * -- and two nested ranges can share a start or an end. So at one offset a
 * closing comes before an opening, closings run innermost first, and openings
 * outermost first. Splicing one probe at a time instead would move every
 * offset after the first insertion.
 */
export function probeSource(source: string, sites: ProbeSite[]): string {
  /* `order` 0 is a closing, 1 an opening; `length` is the whole range's. */
  const events: Array<{ at: number; order: 0 | 1; length: number; text: string }> = [];
  for (const site of sites) {
    const length = site.end - site.start;
    events.push({ at: site.start, order: 1, length, text: opening(site.id) });
    events.push({ at: site.end, order: 0, length, text: closing(site.id) });
  }
  events.sort((a, b) => a.at - b.at
    || a.order - b.order
    || (a.order === 0 ? a.length - b.length : b.length - a.length));

  let out = "";
  let cursor = 0;
  for (const event of events) {
    out += source.slice(cursor, event.at) + event.text;
    cursor = event.at;
  }
  return out + source.slice(cursor);
}
