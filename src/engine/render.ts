/**
 * Rasterises a board file to PNG in headless Chromium.
 *
 * This is the one part of the pipeline that genuinely needs a browser: an
 * accurate raster requires a real canvas and the Excalifont webfonts actually
 * loaded. Everything upstream (layout, conversion, file writing) stays in Node.
 *
 * Assets are served through Playwright request interception rather than a real
 * HTTP server, so there is no port to allocate and nothing to tear down.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BoardFile } from "./board-file";
import { excalidrawFontsDir } from "./excalidraw-assets";
// The display limit and the draw-time verdict divide by the same number, or the
// warning describes an image nobody will receive. See MAX_SIDE below.
import { MAX_RENDER_SIDE } from "./viewable";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BROWSER_BUNDLE = path.join(ROOT, "vendor/excalidraw-browser.js");
const ORIGIN = "http://board.local";

/**
 * playwright-core carries no browser download, so installing this package stays
 * a few seconds rather than ~150 MB. Rendering is the only feature that needs
 * Chromium, so it asks for it at the point of use instead of at install time.
 */
async function launchChromium() {
  const { chromium } = await import("playwright-core");
  try {
    return await chromium.launch();
  } catch (error) {
    const message = String(error);
    if (!/Executable doesn't exist|Failed to launch|browserType.launch/i.test(message)) throw error;
    // Version-pinned: playwright-core only runs the browser revision it was
    // built against, and a bare `playwright install` fetches whatever is latest.
    const version = await playwrightVersion();
    throw new Error(
      "Rendering a PNG needs a headless browser, which is not installed yet. Run:\n"
        + `  npx playwright@${version} install chromium\n`
        + "Drawing, reading and the live board all work without it.",
    );
  }
}

async function playwrightVersion(): Promise<string> {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve("playwright-core/package.json");
    return JSON.parse(await readFile(manifest, "utf8")).version as string;
  } catch {
    return "latest";
  }
}

const MIME_BY_EXT: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/**
 * The largest side a rendered board may have.
 *
 * Not a rendering limit -- Excalidraw will happily draw larger -- but the point
 * past which the image cannot be shown to the caller that asked for it. A model
 * client refuses an image over 2000px on a side, so a render above this is work
 * done, paid for, and then thrown away with an error the caller cannot act on:
 * the board is too big, and the only knob it was given is a scale it already
 * set to the lowest useful value.
 *
 * So the scale is treated as a ceiling rather than a promise. A board that
 * cannot be drawn at the scale requested is drawn at the largest scale that
 * fits, and the caller is told what it got -- silently returning a smaller
 * image would make two boards look like the same size at different zooms.
 *
 * The number itself lives in `viewable.ts`, which divides by it at draw time so
 * a board is told it is unviewable before anybody pays for the picture (#183).
 */
const MAX_SIDE = MAX_RENDER_SIDE;

/**
 * A PNG's pixel dimensions, read from its header.
 *
 * The IHDR chunk is fixed-position -- 8 bytes of signature, 8 of chunk header,
 * then width and height as big-endian 32-bit integers -- so this needs no image
 * library. Read from the bytes rather than trusted from the scale that was
 * asked for, because the whole point here is that the two can differ.
 */
export function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

export interface RenderOptions {
  /**
   * Pixel ratio; 2 gives a crisp image on retina displays.
   *
   * A ceiling, not a guarantee: see `MAX_SIDE`. Read the `scale` on the result
   * to find out what was actually used.
   */
  scale?: number;
  background?: boolean;
  padding?: number;
}

export interface RenderResult {
  png: Buffer;
  /** Pixel dimensions of the image actually produced. */
  width: number;
  height: number;
  /** The scale used, which is `requested` unless the cap reduced it. */
  scale: number;
  requested: number;
}

export async function renderBoardToPng(
  board: BoardFile,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const visible = board.elements.filter((element) => element.isDeleted !== true);
  if (visible.length === 0) throw new Error("Cannot render an empty board");

  if (!existsSync(BROWSER_BUNDLE)) {
    throw new Error(`Missing ${path.relative(ROOT, BROWSER_BUNDLE)}. Run \`npm run build:vendor\`.`);
  }

  const requested = options.scale ?? 2;

  const browser = await launchChromium();
  try {
    const page = await browser.newPage();

    // Serve the bundle and Excalidraw's own assets (fonts especially, or text
    // rasterises in a fallback face) from a synthetic origin.
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/") {
        return route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><html><head><meta charset=utf-8></head><body></body></html>",
        });
      }
      if (url.pathname === "/excalidraw-browser.js") {
        return route.fulfill({
          body: await readFile(BROWSER_BUNDLE),
          contentType: "text/javascript",
        });
      }

      // Fonts are the only other thing the page asks for — traced, and the
      // reason @excalidraw/excalidraw need not be installed at runtime. Anything
      // else is not something this render has ever needed.
      const fonts = excalidrawFontsDir();
      const match = /^\/fonts\/(.+)$/.exec(url.pathname);
      if (!fonts || !match) return route.fulfill({ status: 404, body: "not found" });

      const file = path.join(fonts, match[1]);
      // Never let a crafted path escape the asset root.
      if (!file.startsWith(`${fonts}${path.sep}`)) {
        return route.fulfill({ status: 403, body: "forbidden" });
      }
      try {
        return route.fulfill({
          body: await readFile(file),
          contentType: MIME_BY_EXT[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        });
      } catch {
        return route.fulfill({ status: 404, body: "not found" });
      }
    });

    await page.goto(`${ORIGIN}/`);
    // esbuild (via tsx) wraps functions in its `__name` helper to preserve
    // names. Playwright serialises the evaluate callback as source, so that
    // helper has to exist in the page or the callback throws on entry.
    await page.addScriptTag({ content: "globalThis.__name ||= (fn) => fn;" });
    await page.addScriptTag({ content: "window.EXCALIDRAW_ASSET_PATH = '/';" });
    // Fetched through the route above rather than inlined: holding the 13 MB
    // bundle as a JS string per render is enough to exhaust the heap.
    await page.addScriptTag({ url: "/excalidraw-browser.js" });

    const drawn = await page.evaluate(
      async ({ elements, appState, files, scale, background, padding, maxSide }) => {
        const api = (window as unknown as { ExcalidrawExport: { exportToBlob: (args: unknown) => Promise<Blob> } })
          .ExcalidrawExport;
        let used = scale;
        const blob = await api.exportToBlob({
          elements,
          appState: { ...appState, exportBackground: background },
          files: files ?? {},
          mimeType: "image/png",
          /*
           * Top level, not on appState.
           *
           * `exportToBlob` reads `exportPadding` from its own options and never
           * looks at the one on appState, so for as long as this was passed
           * there the option did nothing and every render came out with
           * Excalidraw's default 10. Found by checking a predicted image size
           * against a real one: they were off by exactly 28px, twice the
           * difference between 24 and 10, on every board regardless of content.
           */
          exportPadding: padding,
          // The canvas must grow with the scale factor. Returning the
          // unscaled size draws 2x content into a 1x canvas, which silently
          // crops everything outside the top-left quadrant.
          //
          // And it must stop growing at `maxSide`, or a large board renders
          // into an image nobody can be shown. The fitted scale is recorded so
          // the caller learns it was not given what it asked for.
          getDimensions: (width: number, height: number) => {
            const fits = maxSide / Math.max(width, height);
            const effective = Math.min(scale, fits);
            used = effective;
            return {
              width: Math.max(1, Math.round(width * effective)),
              height: Math.max(1, Math.round(height * effective)),
              scale: effective,
            };
          },
        });
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("Could not read exported blob"));
          reader.readAsDataURL(blob);
        });
        return { dataUrl, scale: used };
      },
      {
        elements: visible,
        appState: board.appState ?? {},
        files: board.files ?? {},
        scale: requested,
        background: options.background ?? true,
        padding: options.padding ?? 24,
        maxSide: MAX_SIDE,
      },
    );

    const base64 = drawn.dataUrl.slice(drawn.dataUrl.indexOf(",") + 1);
    if (!base64) throw new Error("Excalidraw returned an empty image");
    const png = Buffer.from(base64, "base64");
    const size = pngSize(png);
    return { png, width: size.width, height: size.height, scale: drawn.scale, requested };
  } finally {
    await browser.close();
  }
}
