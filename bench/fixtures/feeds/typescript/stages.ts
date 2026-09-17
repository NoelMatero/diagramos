// The pipeline stages, in two independent pairs so the plain and hidden flow
// tests do not share a candidate pool.
export function parse(text: string): number {
  return text.length;
}

export function render(n: number): string {
  return String(n);
}

export function collect(text: string): number {
  return text.length;
}

export function format(n: number): string {
  return String(n);
}
