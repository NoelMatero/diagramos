export function namedTop(n: number): number { return helper(n) + 1 }
function helper(n: number): number { return n * 2 }

export class Widget {
  private size = 0
  constructor(size: number) { this.size = size; this.record() }
  record(): void { helper(this.size) }
  get doubled(): number { return helper(this.size) }
  async later(): Promise<number> { await Promise.resolve(); return helper(this.size) }
}

export const arrowConst = (n: number) => helper(n)

export function viaCallback(items: number[]): number[] {
  return items.map(x => helper(x))
}

export function viaLibrary(items: number[]): number[] {
  return items.filter(function (x) { return helper(x) > 2 })
}

const AT_IMPORT = helper(7)
export function readsImport(): number { return AT_IMPORT }

export function held(items: number[]): number {
  const chosen = helper
  return items.reduce((total, x) => total + chosen(x), 0)
}

export class Sized extends Widget {
  static make(size: number): Sized {
    return new Sized(size)
  }
}
