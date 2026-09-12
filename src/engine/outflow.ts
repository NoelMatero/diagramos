/**
 * Does this value reach a door? (#203, #270)
 *
 * #270 enumerated the doors -- the calls that touch files, the network and
 * other processes (`outside.ts`) -- and answered the **routine** version of the
 * question with a backward walk, at 0 false "never" on 90 real paths. This is
 * the **value** version, which is the one #203 keeps arriving at:
 *
 *   > This value is created here. Does it ever reach something that writes it
 *   > to a file, sends it over the network, or hands it to another process?
 *
 * Almost nothing here is new machinery, and that is the argument for doing it
 * this way round. `dataflow.ts` already follows a value through the locals of a
 * body and models a collection as one value; a door call site already carries
 * `reached`, the producers whose results arrived there and the locals they came
 * through. `outside.ts` already knows which calls are doors. This joins the two
 * by routine and line, and adds one rule of its own -- the collection one.
 *
 * ## Confirming only, which is a decision and not a stage
 *
 * There is no "this value never reaches a door" here and there must not be. A
 * door this reader cannot see costs **silence**, which the engine accepts
 * everywhere. The opposite verdict is an accusation, and the measurements say
 * plainly that it would be a false one:
 *
 *   - Until #203 recorded a call site for a call written on a receiver, 87.4%
 *     of Python's doors were invisible here -- `os.replace`, `shutil.rmtree`,
 *     `subprocess.run`. That is fixed, and it is the reason to distrust the
 *     shape of the question rather than to trust the fix.
 *   - `tsx` is still 0 of 4 doors and `rust` 0 of 1 (`measure:door-values`).
 *   - A door written on a **handle** -- `f.write(row)`, where `f` came back from
 *     `open()` -- is not in the population at all, because `outside.ts` reads it
 *     as a method on a value rather than a module. Knowing `f` is a file needs
 *     a type.
 *   - 1,147 values reach a call at a position nothing can attribute, because a
 *     spread may arrive as no parameters, one, or many.
 *
 * Any one of those makes "never" wrong about a value handed straight out. A
 * wrong red is the one thing this project cannot take back (`licence.ts`).
 *
 * ## One body, and the far end is a door rather than a routine
 *
 * No call is resolved and no chain is followed into a callee. A value handed to
 * a routine that writes it out is **not** reported: that is the interprocedural
 * question, it is worth 1.3% by measurement, and `reach.ts` already answers the
 * routine-to-door half of it. Keeping this to one body is what makes every hop
 * something a person can see on one screen.
 *
 * **A measurement's reader.** Nothing consumes this but
 * `scripts/measure-outflow.mts`. It puts no colour on a diagram and no word
 * rests on it.
 */
import { readBodies, type Body, type CallSite } from "./dataflow";
import { outsideCallsIn, type OutsideKind } from "./outside";
import { type Language } from "./parse";

/** How the value got to the door. */
export type OutflowVia =
  /** The value is written as an argument of the door call itself. */
  | "handed-to-the-door"
  /** It reached the argument through one or more of the body's own locals. */
  | "through-a-local"
  /** It was put in a collection, and the collection went out. */
  | "out-of-a-collection";

/** What `value` names, because the two read differently on a diagram. */
export type OutflowNames =
  /** A routine whose *result* reaches the door -- `parse` in `parse(x)`. */
  | "a-producer"
  /** A binding in this body -- the name a person would point at. */
  | "a-local";

/** One value, one door, and the path between them. */
export interface Outflow {
  /** The routine the whole path is written in. */
  routine: string;
  value: string;
  names: OutflowNames;
  /** The locals it came through, in order, ending at the one handed over. */
  through: string[];
  door: { kind: OutsideKind; qualified: string; line: number };
  via: OutflowVia;
  /**
   * Which argument of the door call the value arrived as, when that is known.
   *
   * The qualifier that matters most on any count of these, and it is not a
   * detail. `writeFile(path, contents)` takes both a place and a payload, and
   * "this value is written to a file" means the second. Most of what reaches a
   * file door in real code is the **first** argument -- a directory, a filename
   * -- which reaches the door truthfully and is not the data going out.
   *
   * Not interpreted here, because which position is the payload is a fact about
   * each library function rather than about a grammar, and that is the
   * hand-written table `docs/reading-a-grammar.md` warns about. Reported, so a
   * reader of the number can split it.
   *
   * `undefined` when the value was an inline call at the door -- `write(p,
   * shape(x))` -- whose position nothing here records.
   */
  at?: number;
}

export interface OutflowReading {
  /** False when the source could not be parsed; never a claim either way. */
  read: boolean;
  flows: Outflow[];
}

/** A door, as this reader needs it: what it touches and what it is called. */
interface Door {
  kind: OutsideKind;
  qualified: string;
  line: number;
}

/**
 * Every value in a body that reaches a door written in the same body.
 *
 * Deterministic in source order: doors by line, and within a door the value
 * handed over first, then what reached it, then what a collection held. Two
 * runs give the same list, which is what lets a report be diffed.
 */
export function outflowIn(source: string, language: Language): OutflowReading {
  const outside = outsideCallsIn(source, language);
  if (!outside.read) return { read: false, flows: [] };

  /*
   * Doors by routine and line. A line can hold two doors -- `copy(read(a), b)`
   * -- and both are kept: the question is which door a value reached, so
   * collapsing them would drop one of the answers.
   */
  const doors = new Map<string, Door[]>();
  for (const call of outside.calls) {
    if (call.reading.verdict !== "outside" || !call.routine) continue;
    const key = `${call.routine}\u0000${call.line}`;
    const door: Door = {
      kind: call.reading.kind,
      qualified: call.reading.qualified,
      line: call.line,
    };
    const at = doors.get(key);
    if (at) at.push(door);
    else doors.set(key, [door]);
  }
  if (doors.size === 0) return { read: true, flows: [] };

  const reading = readBodies(source, language);
  const flows: Outflow[] = [];
  /** One value per door, so a name mentioned twice is not two findings. */
  const seen = new Set<string>();

  const add = (
    routine: string,
    value: string,
    names: OutflowNames,
    through: string[],
    door: Door,
    via: OutflowVia,
    at?: number,
  ): void => {
    const key = `${routine}\u0000${value}\u0000${door.line}\u0000${door.qualified}`;
    if (seen.has(key)) return;
    seen.add(key);
    flows.push({ routine, value, names, through, door, via, ...(at === undefined ? {} : { at }) });
  };

  for (const body of reading.bodies) {
    // Routines only. A file's top level has no door question worth asking on a
    // diagram: there is no box to anchor the near end at.
    if (body.scope !== "routine") continue;

    const collections = new Map<string, Body["locals"][number]>();
    for (const local of body.locals) {
      if (local.collection) collections.set(local.name, local);
    }
    /** Locals put into each collection, so a container can be expanded. */
    const inside = new Map<string, string[]>();
    for (const local of body.locals) {
      for (const container of local.inside) {
        const list = inside.get(container);
        if (list) list.push(local.name);
        else inside.set(container, [local.name]);
      }
    }

    /*
     * The door's **own** call site, not every call on the door's line.
     *
     * Keying by line alone was wrong, and wrong in a way that read as right:
     * `readFileSync(path.join(root, file), "utf8")` puts two calls on one line,
     * so `path.join`'s arguments were attributed to the door and `file` was
     * reported as arriving at `readFileSync` position 1 -- which is `join`'s
     * position, and `readFileSync` has no second value argument at all. The
     * flow was true and the path was not, and a path nobody can follow is worth
     * less than silence.
     *
     * The door's last name segment is what a bare call site carries
     * (`writeFileSync`), and a call written on a namespace or a module -- the
     * usual Python spelling -- carries no name, so an unnamed site on the line
     * is the fallback. Anything else on the line is left alone.
     */
    const siteForDoor = (line: number, qualified: string): CallSite | undefined => {
      const onLine = body.calls.filter((site) => site.line === line);
      const member = qualified.split(".").pop() ?? qualified;
      return onLine.find((site) => site.callee === member)
        ?? onLine.find((site) => site.callee === "");
    };

    for (const [key, here] of doors) {
      const [routine, at] = key.split("\u0000");
      if (routine !== body.routine) continue;
      const line = Number(at);
      for (const door of here) {
        const site = siteForDoor(line, door.qualified);
        if (site) atDoor(site, door, body.routine);
      }
    }

    /** What one door call site says, in the order a reader should hear it. */
    function atDoor(site: CallSite, door: Door, routine: string): void {
      /** Where a name sits in the door's argument list, when it sits in one. */
      const positionOf = (name: string): number | undefined => {
        const at = site.args.indexOf(name);
        return at === -1 ? undefined : at;
      };

      // 1. The names written at the door, which need no following at all.
      for (const name of site.passed) {
        add(routine, name, "a-local", [], door, "handed-to-the-door", positionOf(name));
      }

      /*
       * 2. The producers whose results arrived here, with the locals they came
       * through. `dataflow.ts` computed this for `@feeds`; the only difference
       * is that the far end is a door instead of a second routine.
       */
      for (const [producer, hops] of site.reached) {
        /*
         * No hops means the call is written at the door itself --
         * `writeFileSync(path, shape(rows))` -- and one hop already means a
         * local carried it there. Getting that boundary wrong labelled 97.6% of
         * the corpus `handed-to-the-door` on the first run, which read as though
         * following a value had bought nothing.
         */
        const handed = hops.length > 0 ? hops[hops.length - 1]! : undefined;
        add(routine, producer, "a-producer", hops,
          door, hops.length > 0 ? "through-a-local" : "handed-to-the-door",
          handed === undefined ? undefined : positionOf(handed));
      }

      /*
       * 3. The collection rule, which is the one thing added here. A container
       * handed to a door takes everything in it out, and the index is
       * deliberately not tracked: the collection is one value and this is
       * everything that went into it. That is #203's own example --
       * `v.push(widget); use(v[i])` -- with a door at the far end.
       */
      for (const name of site.passed) {
        const container = collections.get(name);
        if (!container) continue;
        for (const [producer, path] of container.holds) {
          add(routine, producer, "a-producer", [...path, name], door,
            "out-of-a-collection", positionOf(name));
        }
        for (const held of inside.get(name) ?? []) {
          add(routine, held, "a-local", [name], door, "out-of-a-collection", positionOf(name));
        }
      }
    }
  }

  return { read: true, flows };
}
