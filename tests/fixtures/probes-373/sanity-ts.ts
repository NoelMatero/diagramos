export const fixture = {
  name: "sanity-ts",
  files: {
    "tsconfig.json": '{ "compilerOptions": { "strict": true } }\n',
    "b.ts": "export function double(x: number): number { return x * 2; }\nexport function triple(x: number): number { return x * 3; }\n",
    "a.ts": 'import { double } from "./b";\nexport function run(x: number): number { return double(x); }\n',
  },
  arrows: [
    ["plain call (correct)", "a.ts#run", "b.ts#double", "calls"],
    ["PLANTED WRONG: run does not call triple", "a.ts#run", "b.ts#triple", "calls"],
    ["plain import (correct)", "a.ts", "b.ts", "needs"],
    ["PLANTED WRONG: backwards import", "b.ts", "a.ts", "needs"],
  ],
};
