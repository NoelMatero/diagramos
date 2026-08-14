/**
 * Where a project keeps its diagrams, and what happens when it says something
 * impossible.
 *
 * The rule this file guards: a config that exists but cannot be honoured is an
 * error, never a quiet fall back to the default. Looking somewhere other than
 * where the project said, silently, is the failure the whole setting exists to
 * remove — doing it again as error handling would leave nothing on screen to
 * explain why the check went blind.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CONFIG_FILE, ConfigError, DEFAULT_DIAGRAM_DIR, diagramDir, readProjectConfig } from "../src/engine/config";

let project: string;

function config(contents: string): void {
  writeFileSync(path.join(project, CONFIG_FILE), contents);
}

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), "diagramos-config-"));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("the diagram directory", () => {
  it("is docs/diagrams when the project says nothing", () => {
    expect(diagramDir(project)).toBe(DEFAULT_DIAGRAM_DIR);
    expect(readProjectConfig(project)).toEqual({ diagrams: DEFAULT_DIAGRAM_DIR });
  });

  it("is whatever the committed file says", () => {
    config(JSON.stringify({ diagrams: "docs/architecture" }));
    expect(diagramDir(project)).toBe("docs/architecture");
  });

  it("normalises the value so one directory has one spelling", () => {
    // Otherwise "docs/diagrams" and "./docs/diagrams/" would compare unequal in
    // the create_diagram check while naming the same place.
    config(JSON.stringify({ diagrams: "./docs/architecture/" }));
    expect(diagramDir(project)).toBe(path.join("docs", "architecture"));
  });

  it("falls back to the default for a file that omits the key", () => {
    config(JSON.stringify({ somethingElse: true }));
    expect(diagramDir(project)).toBe(DEFAULT_DIAGRAM_DIR);
  });
});

describe("a config that cannot be honoured", () => {
  it("refuses a path that leaves the project", () => {
    config(JSON.stringify({ diagrams: "../elsewhere" }));
    expect(() => diagramDir(project)).toThrow(ConfigError);
    expect(() => diagramDir(project)).toThrow(/stay inside the project/);
  });

  it("refuses an absolute path", () => {
    config(JSON.stringify({ diagrams: "/etc" }));
    expect(() => diagramDir(project)).toThrow(/relative to the project/);
  });

  it("refuses a value that is not a non-empty string", () => {
    for (const value of [42, "", "   ", null, [], {}]) {
      config(JSON.stringify({ diagrams: value }));
      expect(() => diagramDir(project), JSON.stringify(value)).toThrow(/non-empty string/);
    }
  });

  it("refuses a file that is not JSON, naming the file", () => {
    config("{oops");
    expect(() => diagramDir(project)).toThrow(new RegExp(`${CONFIG_FILE.replace(".", "\\.")} is not valid JSON`));
  });

  it("refuses a JSON document that is not an object", () => {
    for (const document of ['"docs/diagrams"', "[]", "7", "null"]) {
      config(document);
      expect(() => diagramDir(project), document).toThrow(/must contain a JSON object/);
    }
  });

  it("never silently substitutes the default", () => {
    // The point of every case above: no path through this returns
    // docs/diagrams while the project asked for something else.
    config(JSON.stringify({ diagrams: "../escape" }));
    let returned: string | undefined;
    try {
      returned = diagramDir(project);
    } catch {
      returned = undefined;
    }
    expect(returned).toBeUndefined();
  });
});
