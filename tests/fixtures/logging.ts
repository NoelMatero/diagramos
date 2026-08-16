// The same logging feature as logging.rs, in TypeScript. See that file for the
// cast: LOGGER / logLine / serveRequest / parseHeader / the three-layer chain.
//
// This one also carries the things a lexer gets wrong: a regex holding quotes,
// a template literal, an apostrophe in a comment, and a string that mentions
// the symbols without using them.

const LOGGER: string[] = [];

/** Don't be fooled: this comment mentions logLine and LOGGER and is not a use. */
export function logLine(message: string): void {
  LOGGER.push(`[log] ${message}`);
}

const HEADER = /^["']?([A-Za-z-]+)["']?:/;

export function serveRequest(path: string): number {
  logLine(`serving ${path}`);
  return path.length;
}

export function parseHeader(raw: string): string | undefined {
  return HEADER.exec(raw)?.[1];
}

export function emitBatch(lines: string[]): void {
  for (const line of lines) {
    logLine(line);
  }
}

export function handleLogging(message: string): void {
  emitBatch([message]);
}

export function handleFail(message: string): void {
  handleLogging(message);
}

export const NOTE = "logLine and LOGGER appear here but this is a string";
