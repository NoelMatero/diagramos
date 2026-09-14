import { expect, test } from "vitest"
import { arrowConst, held, namedTop, readsImport, Sized, viaCallback, viaLibrary, Widget } from "./src/lib"

test("shapes", async () => {
  expect(namedTop(1)).toBe(3)
  const w = new Widget(3)
  w.record()
  expect(w.doubled).toBe(6)
  expect(await w.later()).toBe(6)
  expect(arrowConst(2)).toBe(4)
  expect(viaCallback([1, 2])).toEqual([2, 4])
  expect(viaLibrary([1, 2, 3])).toEqual([2, 3])
  expect(readsImport()).toBe(14)
  expect(held([1, 2, 3])).toBe(12)
  expect(Sized.make(4).doubled).toBe(8)
})
