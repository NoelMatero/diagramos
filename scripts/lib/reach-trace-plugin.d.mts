/** Types for `reach-trace-plugin.mjs`, which is plain JavaScript because vitest loads it. */
export declare const NOT_SOURCE: RegExp;
export declare function repoSourceFile(id: string, root: string): string | undefined;
export declare function insertionsFor(source: string, file: string): {
  insertions: Array<{ at: number; text: string }>;
  functions: Array<{ line: number }>;
};
export declare function instrument(source: string, file: string, relative: string): string | undefined;
export declare function reachTrace(options: { root: string; skip?: string[] }): {
  name: string;
  enforce: "pre";
  transform(code: string, id: string): { code: string; map: null } | undefined;
};
