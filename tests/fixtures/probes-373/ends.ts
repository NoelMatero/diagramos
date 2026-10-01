const L = (...xs: string[]) => xs.join("\n\n") + "\n";
export const fixture = {
  name: "ends",
  files: {
    "tsconfig.json": '{ "compilerOptions": { "strict": true, "jsx": "preserve", "target": "es2022" } }\n',
    "cart.ts": L(
      "export class Cart {\n  total(): number {\n    return 1;\n  }\n}",
      "export function helper(): number {\n  return 2;\n}",
      "export const top = helper();",
    ),
    "widget.tsx": L(
      "export function Widget(props: { n: number }) {\n  return <b>{props.n}</b>;\n}",
    ),
    "app.tsx": L(
      'import { Widget } from "./widget";\nimport { Cart, helper } from "./cart";',
      "export function App() {\n  return <Widget n={1} />;\n}",
      "export function checkout(c: Cart): number {\n  return c.total();\n}",
      "export class Shop {\n  pay(c: Cart): number {\n    return c.total() + helper();\n  }\n}",
      "export function makeCart(): Cart {\n  return new Cart();\n}",
    ),
    "cart.py": "class Cart:\n    def total(self):\n        return 1\n\n\ndef helper():\n    return 2\n",
    "shop.py": "from cart import Cart, helper\n\nhelper()\n\n\nclass Shop:\n    def pay(self, c: Cart):\n        return c.total() + helper()\n\n\ndef checkout(c: Cart):\n    return c.total()\n\n\ndef make_cart():\n    return Cart()\n",
  },
  arrows: [
    ["TSX component renders <Widget/> (@calls)", "app.tsx#App", "widget.tsx#Widget", "calls"],
    ["TS fn -> class whose method it calls", "app.tsx#checkout", "cart.ts#Cart", "calls"],
    ["TS class -> fn its method calls", "app.tsx#Shop", "cart.ts#helper", "calls"],
    ["TS class -> class whose method it calls", "app.tsx#Shop", "cart.ts#Cart", "calls"],
    ["TS fn -> class it constructs (@calls)", "app.tsx#makeCart", "cart.ts#Cart", "calls"],
    ["TS file (module top level) -> fn", "cart.ts", "cart.ts#helper", "calls"],
    ["TS file -> file", "app.tsx", "cart.ts", "calls"],
    ["Py fn -> class whose method it calls", "shop.py#checkout", "cart.py#Cart", "calls"],
    ["Py class -> fn its method calls", "shop.py#Shop", "cart.py#helper", "calls"],
    ["Py class -> class", "shop.py#Shop", "cart.py#Cart", "calls"],
    ["Py fn -> class it constructs (@calls)", "shop.py#make_cart", "cart.py#Cart", "calls"],
    ["Py module top level -> fn", "shop.py", "cart.py#helper", "calls"],
    ["Py file -> file", "shop.py", "cart.py", "calls"],
  ],
};
