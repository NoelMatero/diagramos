export const fixture = {
  name: "holds-min",
  files: {
    "engine.py": "class Engine:\n    pass\n",
    "car.py": "from engine import Engine\n\n\nclass Car:\n    def __init__(self):\n        self.engine = Engine()\n",
    "car2.py": "from engine import Engine\n\n\nclass Car2:\n    def __init__(self, engine: Engine):\n        self.engine = engine\n        self.speed = 0\n",
    "car3.py": "from engine import Engine\n\n\nclass Car3:\n    wheels: int\n\n    def __init__(self):\n        self.engine = Engine()\n",
    "tsconfig.json": '{ "compilerOptions": { "strict": true } }\n',
    "engine.ts": "export class Engine {}\n",
    "car.ts": 'import { Engine } from "./engine";\n\nexport class Car {\n  engine = new Engine();\n}\n',
    "car2.ts": 'import { Engine } from "./engine";\n\nexport class Car2 {\n  speed = 0;\n  engine = new Engine();\n}\n',
    "car3.ts": 'import { Engine } from "./engine";\n\nexport class Car3 {\n  wheels: number = 4;\n  engine = new Engine();\n}\n',
    "car4.ts": 'import { Engine } from "./engine";\n\nexport class Car4 {\n  private engine: Engine;\n  constructor() {\n    this.engine = new Engine();\n  }\n}\n',
  },
  arrows: [
    ["Py self.engine = Engine() in __init__", "car.py#Car", "engine.py#Engine", "holds"],
    ["Py self.engine = engine (param: Engine)", "car2.py#Car2", "engine.py#Engine", "holds"],
    ["Py class has an annotated field AND self.engine = Engine()", "car3.py#Car3", "engine.py#Engine", "holds"],
    ["TS engine = new Engine() (only field)", "car.ts#Car", "engine.ts#Engine", "holds"],
    ["TS speed = 0; engine = new Engine()", "car2.ts#Car2", "engine.ts#Engine", "holds"],
    ["TS typed field + engine = new Engine()", "car3.ts#Car3", "engine.ts#Engine", "holds"],
    ["TS typed field assigned in ctor (control-correct)", "car4.ts#Car4", "engine.ts#Engine", "holds"],
  ],
};
