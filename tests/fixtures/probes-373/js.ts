export const fixture = {
  name: "js",
  files: {
    "package.json": '{ "name": "probe", "type": "module" }\n',
    "config.js": "export class Config {\n  constructor() {\n    this.width = 1;\n    this.height = 2;\n  }\n}\n\nexport function Legacy() {\n  this.size = 3;\n}\nLegacy.prototype.grow = function () {\n  return this.size + 1;\n};\n",
    "r.js": 'import { Config, Legacy } from "./config.js";\n\nexport function destructure(c) {\n  const { width } = c;\n  return width;\n}\n\nexport function plain(c) {\n  return c.height;\n}\n\nexport function proto(l) {\n  return l.size;\n}\n\nexport function bracket(c) {\n  return c["width"];\n}\n\nexport function viaThis() {\n  const self = this;\n  return self.width;\n}\n\nexport function jsonAll(c) {\n  return JSON.stringify(c);\n}\n',
    "cjs/a.cjs": 'const { Config } = require("../config.js");\nmodule.exports = () => new Config();\n',
    "dyn.js": 'export async function load() {\n  const m = await import("./config.js");\n  return new m.Config();\n}\n',
  },
  arrows: [
    ["JS destructuring", "r.js#destructure", "config.js#Config", "accesses", "width"],
    ["JS plain read", "r.js#plain", "config.js#Config", "accesses", "height"],
    ["JS constructor-function prototype field", "r.js#proto", "config.js#Legacy", "accesses", "size"],
    ["JS bracket read", "r.js#bracket", "config.js#Config", "accesses", "width"],
    ["JS alias of this", "r.js#viaThis", "config.js#Config", "accesses", "width"],
    ["JS JSON.stringify", "r.js#jsonAll", "config.js#Config", "accesses", "width"],
    ["JS ESM import (@needs)", "r.js", "config.js", "needs"],
    ["CJS require (@needs)", "cjs/a.cjs", "config.js", "needs"],
    ["JS dynamic import (@needs)", "dyn.js", "config.js", "needs"],
    ["CONTROL wrong: plain reads width", "r.js#plain", "config.js#Config", "accesses", "width"],
  ],
};
