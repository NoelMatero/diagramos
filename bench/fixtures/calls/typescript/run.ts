// Calls, one per shape.
//
// Direct-call shape from .corpus/vitejs-vite/packages/vite/src/node/cli.ts.
// Dispatch-table shape from .corpus/vitejs-vite/packages/vite/src/node/build.ts:1639
// — `} as const satisfies Record<string, (relativePath: string) => string>`,
// a routine reached through a table rather than by name.

export function render(n: number): number {
  return n;
}

/** PLAINLY TRUE: the call is written here. */
export function run(): number {
  return render(1);
}

/** TRUE BUT HIDDEN: this really does reach `render`, through a value. */
export function runViaCallback(f: (n: number) => number): number {
  return f(1);
}

/** The wiring that makes the hidden one true. Kept off the board on purpose. */
export function wire(): number {
  return runViaCallback(render);
}

/** FALSE AND UNPROVABLE: this calls nothing. */
export function unrelated(): number {
  return 0;
}

/** WRONG KIND OF END: data. There is no body here to read. */
export interface Config {
  width: number;
}
