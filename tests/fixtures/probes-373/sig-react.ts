export const fixture = {
  name: "sig-react",
  files: {
    "tsconfig.json": '{ "compilerOptions": { "strict": true, "jsx": "preserve", "target": "es2022" } }\n',
    "fc.ts": "export type FC<P> = (props: P) => unknown;\nexport interface ButtonProps {\n  label: string;\n}\nexport interface Req {\n  url: string;\n}\nexport interface Res {\n  ok: boolean;\n}\nexport type Handler = (req: Req) => Res;\n",
    "button.tsx": 'import type { FC, ButtonProps } from "./fc";\n\nexport const Button: FC<ButtonProps> = (props) => {\n  return <b>{props.label}</b>;\n};\n\nexport const Plain = (props: ButtonProps) => <b>{props.label}</b>;\n',
    "route.ts": 'import type { Handler, Req, Res } from "./fc";\n\nexport const handle: Handler = (req) => ({ ok: req.url.length > 0 });\n\nexport const satisfying = ((req: Req): Res => ({ ok: true })) satisfies Handler;\n',
  },
  arrows: [
    ["React.FC<Props>-typed component takes Props", "fc.ts#ButtonProps", "button.tsx#Button", "takes"],
    ["plainly typed component takes Props (control-correct)", "fc.ts#ButtonProps", "button.tsx#Plain", "takes"],
    ["Handler-typed const takes Req", "fc.ts#Req", "route.ts#handle", "takes"],
    ["Handler-typed const returns Res", "fc.ts#Res", "route.ts#handle", "returns"],
    ["satisfies Handler takes Req (control-correct)", "fc.ts#Req", "route.ts#satisfying", "takes"],
  ],
};
