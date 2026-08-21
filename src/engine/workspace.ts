/**
 * The filesystem, narrowed to what a check needs and injected so every check is
 * testable without a real tree.
 *
 * Lives in its own module because two things need it and neither should have to
 * import the other: `drift.ts` compares a board against it, and `resolve.ts`
 * turns an import specifier into a file with it.
 */
export interface Workspace {
  /** Absolute path for a repo-relative ref; undefined when it escapes the root. */
  resolve(relativePath: string): string | undefined;
  stat(absolutePath: string): "file" | "directory" | "missing";
  /** Only called when stat said "file". */
  read(absolutePath: string): string;
  /**
   * Entry names directly inside a directory, unsorted, never recursive.
   *
   * One level is the whole security design for globs: a ref can name a single
   * directory's listing and never a search. Only called when stat said
   * "directory"; an unreadable directory is an empty list, not a throw.
   */
  list(absolutePath: string): string[];
}
