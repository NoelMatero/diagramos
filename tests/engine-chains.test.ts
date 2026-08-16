/**
 * Named routes, and keeping a concept box honest.
 *
 * The one-hop limit has an obvious objection: indirection is the most common
 * thing in programming. `handle_fail -> handle_logging -> emit_batch ->
 * log_line!` is an ordinary chain, and the true arrow `handle_fail -> log`
 * flags under direct-plus-one-hop, which is a false alarm.
 *
 * Walking deeper is not the fix -- reachability blesses everything, and that
 * was measured. The fix is a distinction: an unnamed chain is undetectable, a
 * *named* one is just a list of one-hop checks. So the author writes the route
 * down and the machine verifies every link of it, forever, and can say which
 * link broke.
 *
 * The second half of this file is the price of membership. Letting any one of
 * a box's symbols satisfy an arrow opens a hole -- cut the deepest call and
 * every caller still calls a listed member, so everything stays green while
 * the concept is hollow. The self-support rule closes it.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { chainBreak, reaches, unsupportedMembers } from "../src/engine/body";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, type Workspace } from "../src/engine/drift";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

function fakeWorkspace(files: Record<string, string>): Workspace {
  return {
    resolve: (relative) => (relative.startsWith("../") ? undefined : relative),
    stat: (target) => (files[target] === undefined ? "missing" : "file"),
    read: (target) => files[target] ?? "",
    list: () => [],
  };
}

async function boardWith(
  nodes: Array<{ id: string; label: string; ref?: string; refs?: string[] }>,
  edges: Array<{ from: string; to: string; via?: string[] }>,
): Promise<BoardFile> {
  return (await createDiagram(emptyBoard(), { name: "arch", nodes, edges })).board;
}

beforeAll(async () => {
  await boardWith([{ id: "warmup", label: "Warm up" }], []);
}, 60_000);

/**
 * The chain from the design, three layers deep, in the shape of the real file.
 * `handle_fail` reaches the logging only through two intermediaries.
 */
function chainFile(deepestLogs: boolean): string {
  return [
    "lazy_static! {",
    "    static ref LOGGER: Mutex<std::fs::File> = Mutex::new(open_log());",
    "}",
    "",
    "macro_rules! log_line {",
    "    ($($arg:tt)*) => {{",
    "        if let Ok(mut file) = LOGGER.lock() {",
    '            let _ = writeln!(file, "{}", format!($($arg)*));',
    "        }",
    "    }};",
    "}",
    "",
    "pub fn emit_batch(lines: &[String]) {",
    deepestLogs
      ? '    for line in lines { log_line!("{}", line); }'
      : "    for line in lines { let _ = line; }",
    "}",
    "",
    "pub fn handle_logging(msg: &str) {",
    "    emit_batch(&[msg.to_string()]);",
    "}",
    "",
    "pub fn handle_fail(msg: &str) {",
    "    handle_logging(msg);",
    "}",
    "",
    "pub fn unrelated() -> usize { 7 }",
  ].join("\n");
}

const INTACT = chainFile(true);
const CUT = chainFile(false);
const LOG = ["LOGGER", "log_line"];

describe("walking a route the author named", () => {
  it("holds all the way down an intact chain", () => {
    expect(chainBreak(INTACT, "handle_fail", ["handle_logging", "emit_batch"], LOG, "rust"))
      .toBeUndefined();
  });

  it("names the hop that stopped holding, which is the whole point", () => {
    // Cut the deepest link only. Every other hop is intact, and a check that
    // could only say "this arrow looks unsupported" would leave the reader to
    // find this by hand.
    const broken = chainBreak(CUT, "handle_fail", ["handle_logging", "emit_batch"], LOG, "rust");
    expect(broken).toMatchObject({ at: "emit_batch", unreadable: false });
    expect(broken!.next).toBe("LOGGER or log_line");
  });

  it("names a hop broken in the middle, not just at the end", () => {
    const skipped = chainBreak(INTACT, "handle_fail", ["emit_batch"], LOG, "rust");
    // `handle_fail` calls `handle_logging`, not `emit_batch` -- the route as
    // written is wrong even though the two ends are genuinely connected.
    expect(skipped).toMatchObject({ at: "handle_fail", next: "emit_batch" });
  });

  it("stops at the first hop that fails, not the first one missing", () => {
    // `handle_logging` calls `emit_batch`, not `vanished`, so the route is
    // already wrong there -- and it says so rather than running on to report
    // the name that happens not to exist.
    const gone = chainBreak(INTACT, "handle_fail", ["handle_logging", "vanished"], LOG, "rust");
    expect(gone).toMatchObject({ at: "handle_logging", next: "vanished", unreadable: false });
  });

  it("calls a hop with no body here unreadable, which is not a break", () => {
    // Every link holds until `writeln`, which is std's macro and declared
    // nowhere in this file. Not knowing is different from knowing it is wrong.
    const opaque = chainBreak(
      INTACT,
      "handle_fail",
      ["handle_logging", "emit_batch", "log_line", "writeln"],
      LOG,
      "rust",
    );
    expect(opaque).toMatchObject({ at: "writeln", unreadable: true });
  });
});

describe("an arrow carrying via", () => {
  const files = { "src/lib.rs": INTACT };

  async function arrow(source: string, via: string[]) {
    const board = await boardWith(
      [
        { id: "a", label: "handle_fail", ref: "src/lib.rs#handle_fail" },
        { id: "b", label: "logging", ref: "src/lib.rs#LOGGER", refs: ["src/lib.rs#log_line"] },
      ],
      [{ from: "a", to: "b", via }],
    );
    return checkDrift(board, fakeWorkspace({ "src/lib.rs": source }));
  }

  it("survives the round trip through customData", async () => {
    const board = await boardWith(
      [
        { id: "a", label: "A", ref: "src/lib.rs#handle_fail" },
        { id: "b", label: "B", ref: "src/lib.rs#LOGGER" },
      ],
      [{ from: "a", to: "b", via: ["handle_logging", "emit_batch"] }],
    );
    const stored = board.elements.find(
      (element) => (element.customData as { edge?: unknown } | undefined)?.edge,
    );
    expect((stored?.customData as { via?: string[] }).via).toEqual([
      "handle_logging",
      "emit_batch",
    ]);
  });

  it("is quiet when the whole route holds", async () => {
    const report = await arrow(INTACT, ["handle_logging", "emit_batch"]);
    expect(report.edges).toEqual([]);
    expect(report.edgesChecked).toBe(1);
  });

  it("is not needed just because the chain is deep, not any more", async () => {
    // This asserted the opposite until the search was measured: one hop made
    // a true three-layer arrow look broken, and `via` was the workaround. The
    // calls are followed all the way now, so the plain arrow is quiet and
    // `via` is for routes worth writing down rather than for depth.
    const board = await boardWith(
      [
        { id: "a", label: "handle_fail", ref: "src/lib.rs#handle_fail" },
        { id: "b", label: "logging", ref: "src/lib.rs#LOGGER", refs: ["src/lib.rs#log_line"] },
      ],
      [{ from: "a", to: "b" }],
    );
    expect(checkDrift(board, fakeWorkspace(files)).edges).toEqual([]);

    // And the arrow still flags when the chain is genuinely cut, which is the
    // thing that would be lost if depth blessed everything.
    const cut = await boardWith(
      [
        { id: "a", label: "handle_fail", ref: "src/lib.rs#handle_fail" },
        { id: "b", label: "logging", ref: "src/lib.rs#LOGGER", refs: ["src/lib.rs#log_line"] },
      ],
      [{ from: "a", to: "b" }],
    );
    expect(checkDrift(cut, fakeWorkspace({ "src/lib.rs": CUT })).edges).toHaveLength(1);
  });

  it("flags the broken link and says where", async () => {
    const report = await arrow(CUT, ["handle_logging", "emit_batch"]);
    expect(report.edges).toHaveLength(1);
    expect(report.edges[0].kind).toBe("broken-chain");
    expect(report.edges[0].detail).toContain("breaks at emit_batch");
    expect(report.edges[0].detail).toContain("worth a look");
  });

  it("separates a stale route from a connection that is really gone", async () => {
    // Two very different pieces of news, and rendering them the same way
    // invites someone to delete an arrow that was right. `serve` logs
    // directly, so the connection holds and only the route is wrong.
    const withCaller = [
      INTACT,
      "",
      "pub fn serve() {",
      '    log_line!("serving");',
      "    unrelated();",
      "}",
    ].join("\n");
    const board = await boardWith(
      [
        { id: "a", label: "serve", ref: "src/lib.rs#serve" },
        { id: "b", label: "logging", ref: "src/lib.rs#LOGGER", refs: ["src/lib.rs#log_line"] },
      ],
      [{ from: "a", to: "b", via: ["unrelated"] }],
    );
    const report = checkDrift(board, fakeWorkspace({ "src/lib.rs": withCaller }));
    expect(report.edges).toHaveLength(1);
    expect(report.edges[0].detail).toContain("still connected, but not by this route");
    expect(report.edges[0].detail).toContain("unrelated");

    // And the opposite: `unrelated` does not log and neither does anything it
    // calls, so nothing is softened. Confirmation only ever adds certainty.
    const absent = await boardWith(
      [
        { id: "a", label: "unrelated", ref: "src/lib.rs#unrelated" },
        { id: "b", label: "logging", ref: "src/lib.rs#LOGGER", refs: ["src/lib.rs#log_line"] },
      ],
      [{ from: "a", to: "b", via: ["handle_logging"] }],
    );
    const gone = checkDrift(absent, fakeWorkspace({ "src/lib.rs": withCaller }));
    expect(gone.edges[0].detail).toContain("the route breaks at");
    expect(gone.edges[0].detail).not.toContain("still connected");
  });

  it("does not quietly fall back to a looser channel when the route fails", async () => {
    // Both ends are in one file, so every file-level channel would say yes.
    // Falling back would throw away the localized message, which is the only
    // thing this shape has that the others do not.
    const report = await arrow(CUT, ["handle_logging", "emit_batch"]);
    expect(report.clean).toBe(false);
  });
});

describe("keeping a concept box from going hollow", () => {
  const members = ["LOGGER", "log_line", "handle_logging", "emit_batch"];

  it("finds nothing to complain about while the chain is intact", () => {
    expect(unsupportedMembers(INTACT, members, "rust")).toEqual([]);
  });

  it("catches the member that no longer shows any trace of the concept", () => {
    // This is the hole membership opens: after the cut, callers still call
    // listed members and every arrow stays green, while the concept does
    // nothing at all. `emit_batch` is where it went hollow.
    expect(unsupportedMembers(CUT, members, "rust")).toEqual(["emit_batch"]);
  });

  it("exempts the data a concept is built on", () => {
    // `LOGGER` is a static: it is the ground the rest of the concept reaches
    // *to*, and asking it to reach back would flag every well-formed box.
    expect(unsupportedMembers(INTACT, ["LOGGER", "log_line"], "rust")).toEqual([]);
    expect(unsupportedMembers(CUT, ["LOGGER", "log_line"], "rust")).toEqual([]);
  });

  it("says nothing about a box that lists one thing", () => {
    // A single member has nothing to connect to, so the question is not asked.
    expect(unsupportedMembers(CUT, ["emit_batch"], "rust")).toEqual([]);
  });

  it("reports it as a finding against the box that made the claim", async () => {
    const board = await boardWith(
      [
        {
          id: "log",
          label: "logging",
          ref: "src/lib.rs#LOGGER",
          refs: ["src/lib.rs#log_line", "src/lib.rs#handle_logging", "src/lib.rs#emit_batch"],
        },
      ],
      [],
    );
    const report = checkDrift(board, fakeWorkspace({ "src/lib.rs": CUT }));
    const hollow = report.findings.filter((finding) => finding.kind === "unsupported-member");
    expect(hollow).toHaveLength(1);
    expect(hollow[0]).toMatchObject({ node: "log", ref: "src/lib.rs#emit_batch" });
    // And an intact board says nothing.
    const intact = checkDrift(board, fakeWorkspace({ "src/lib.rs": INTACT }));
    expect(intact.findings).toEqual([]);
  });
});

/**
 * The search that follows calls all the way down, and the limits it keeps.
 *
 * Depth was measured before it was allowed: on the 640-line Rust file and on
 * this repo's densest TypeScript, reachability saturates after one hop and
 * unlimited depth flags exactly as many arrows. So the fear that motivated the
 * one-hop cap -- that deeper searching blesses everything -- did not survive
 * contact with either corpus, while the false alarm on a genuine three-layer
 * chain was real. These tests hold the new behaviour in place, and hold on to
 * the reasons it is still safe.
 */
describe("following the calls all the way down", () => {
  function rust(...lines: string[]): string {
    return [
      "lazy_static! { static ref LOGGER: Mutex<u8> = Mutex::new(0); }",
      "macro_rules! log_line { ($($a:tt)*) => {{ let _ = LOGGER.lock(); }}; }",
      ...lines,
    ].join("\n");
  }
  const LOG = ["LOGGER", "log_line"];

  it("finds the logging however many layers down it sits", () => {
    const deep = rust(
      'pub fn five() { log_line!("x"); }',
      "pub fn four() { five(); }",
      "pub fn three() { four(); }",
      "pub fn two() { three(); }",
      "pub fn one() { two(); }",
    );
    expect(reaches(deep, "one", LOG, "rust")).toBe(true);
  });

  it("still says no when nothing down there logs", () => {
    // The property that makes depth safe: it is not that the search is shallow,
    // it is that it only follows calls this file owns.
    const deep = rust(
      "pub fn five() -> usize { 5 }",
      "pub fn four() { five(); }",
      "pub fn three() { four(); }",
      "pub fn two() { three(); }",
      "pub fn one() { two(); }",
    );
    expect(reaches(deep, "one", LOG, "rust")).toBe(false);
  });

  it("terminates on a cycle instead of chasing it", () => {
    const looped = rust(
      "pub fn ping(n: usize) { pong(n); }",
      "pub fn pong(n: usize) { ping(n); }",
    );
    expect(reaches(looped, "ping", LOG, "rust")).toBe(false);
  });

  it("does not follow a call through a type or another object, at any depth", () => {
    // The receiver rule is what keeps depth honest. Without it the search
    // wanders into every same-named method a library happens to expose.
    const foreign = rust(
      'pub fn local_helper() { log_line!("x"); }',
      "pub fn caller(other: Thing) { Helper::local_helper(); other.local_helper(); }",
    );
    expect(reaches(foreign, "caller", LOG, "rust")).toBe(false);
  });

  it("refuses the question rather than guessing when the search runs long", () => {
    // A budget running out is the least evidential thing there is, so it
    // cannot come back as "no path" -- that would be a loud wrong answer.
    const wide = rust(
      ...Array.from({ length: 400 }, (_, index) =>
        `pub fn f${index}() { f${index + 1}(); }`),
      "pub fn f400() -> usize { 0 }",
    );
    expect(reaches(wide, "f0", LOG, "rust")).toBeUndefined();
  });

  it("costs about the same as one hop did, on a real file", () => {
    // Both ends of the range: an early hit and a full exhaustive miss.
    const deep = rust(
      'pub fn five() { log_line!("x"); }',
      "pub fn four() { five(); }",
      "pub fn three() { four(); }",
      "pub fn two() { three(); }",
      "pub fn one() { two(); }",
      "pub fn nowhere() -> usize { 1 }",
    );
    const start = performance.now();
    for (let run = 0; run < 50; run += 1) {
      reaches(deep, "one", LOG, "rust");
      reaches(deep, "nowhere", LOG, "rust");
    }
    // Generous: this is a guard against an accidental quadratic, not a
    // benchmark. Measured around 0.4 ms per arrow on the 640-line real file.
    expect((performance.now() - start) / 100).toBeLessThan(20);
  });
});

/**
 * One name, more than one declaration.
 *
 * Rust `impl` blocks make this ordinary: the real file declares both `register`
 * and `reregister` twice. Reading only the first was a false alarm waiting to
 * happen, and false alarms are the direction that gets a check switched off.
 */
describe("a name declared more than once in a file", () => {
  const TWO_IMPLS = [
    "lazy_static! { static ref LOGGER: Mutex<u8> = Mutex::new(0); }",
    "macro_rules! log_line { ($($a:tt)*) => {{ let _ = LOGGER.lock(); }}; }",
    "impl Client {",
    "    fn register(&self) -> usize { self.id }",
    "    fn helper(&self) -> usize { 1 }",
    "}",
    "impl Server {",
    '    fn register(&self) { log_line!("registering"); }',
    "}",
  ].join("\n");
  const LOG = ["LOGGER", "log_line"];

  it("is satisfied by whichever declaration carries the evidence", () => {
    // The first `register` does not log and the second does. Before this, the
    // first one won and the arrow was flagged.
    expect(reaches(TWO_IMPLS, "register", LOG, "rust")).toBe(true);
  });

  it("still says no when none of the declarations carries it", () => {
    expect(reaches(TWO_IMPLS, "helper", LOG, "rust")).toBe(false);
  });

  it("lets a named route pass through whichever declaration holds", () => {
    const routed = [
      TWO_IMPLS,
      "impl Gateway {",
      "    fn entry(&self) { self.register(); }",
      "}",
    ].join("\n");
    expect(chainBreak(routed, "entry", ["register"], LOG, "rust")).toBeUndefined();
  });

  it("counts a member as supported if any of its declarations shows the trace", () => {
    expect(unsupportedMembers(TWO_IMPLS, ["LOGGER", "log_line", "register"], "rust")).toEqual([]);
    // `helper` genuinely shows nothing, in either block.
    expect(unsupportedMembers(TWO_IMPLS, ["LOGGER", "log_line", "helper"], "rust"))
      .toEqual(["helper"]);
  });
});
