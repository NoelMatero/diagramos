const L = (...xs: string[]) => xs.join("\n\n") + "\n";
export const fixture = {
  name: "ts-implicit",
  files: {
    "tsconfig.json": '{ "compilerOptions": { "strict": true, "target": "es2022", "lib": ["es2022", "esnext.disposable", "dom"] } }\n',
    "money.ts": L(
      "export class Money {\n  constructor(private cents: number) {}\n  valueOf(): number {\n    return this.cents;\n  }\n  toJSON(): object {\n    return { cents: this.cents };\n  }\n  toString(): string {\n    return String(this.cents);\n  }\n}",
      "export class Later {\n  then(ok: (v: number) => void): void {\n    ok(1);\n  }\n}",
      "export class Range {\n  *[Symbol.iterator](): Iterator<number> {\n    yield 1;\n  }\n  entries(): number[] {\n    return [1];\n  }\n}",
      "export class Temp {\n  [Symbol.dispose](): void {}\n  close(): void {}\n}",
    ),
    "a.ts": L(
      'import { Money, Later, Range } from "./money";',
      "export function add(m: Money): number {\n  return +m + 1;\n}",
      "export function compare(a: Money, b: Money): boolean {\n  return a > b;\n}",
      "export function serialise(m: Money): string {\n  return JSON.stringify(m);\n}",
      "export function concat(m: Money): string {\n  return 'total ' + m;\n}",
      "export function stringCtor(m: Money): string {\n  return String(m);\n}",
      "export function interp(m: Money): string {\n  return `${m}`;\n}",
      "export async function wait(l: Later): Promise<number> {\n  return await l;\n}",
      "export function loop(r: Range): number {\n  let n = 0;\n  for (const x of r) n += x;\n  return n;\n}",
      "export function spread(r: Range): number[] {\n  return [...r];\n}",
    ),
  },
  arrows: [
    ["unary + -> valueOf", "a.ts#add", "money.ts#valueOf", "calls"],
    ["> comparison -> valueOf", "a.ts#compare", "money.ts#valueOf", "calls"],
    ["JSON.stringify -> toJSON", "a.ts#serialise", "money.ts#toJSON", "calls"],
    ["string + obj -> valueOf/toString", "a.ts#concat", "money.ts#valueOf", "calls"],
    ["String(obj) -> toString", "a.ts#stringCtor", "money.ts#toString", "calls"],
    ["template literal -> toString", "a.ts#interp", "money.ts#toString", "calls"],
    ["await thenable -> then", "a.ts#wait", "money.ts#then", "calls"],
    ["for..of -> generator iterator (arrow to class)", "a.ts#loop", "money.ts#Range", "calls"],
    ["spread -> iterator (arrow to class)", "a.ts#spread", "money.ts#Range", "calls"],
  ],
};
