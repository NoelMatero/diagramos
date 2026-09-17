// TRUE BUT HIDDEN: the only reference to ./model is a dynamic import, whose
// specifier may be built at runtime. The dependency is real; the reader is
// documented to withhold rather than credit it.
//
// Shape from .corpus/vitejs-vite/packages/vite/src/node/cli.ts:227 -- a
// destructured await of a dynamic import, there naming a sibling module.

export async function handle(path: string): Promise<number> {
  const { makeRequest } = await import("./model");
  return makeRequest(path).path.length;
}
