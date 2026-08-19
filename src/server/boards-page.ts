/**
 * The index: every board this service can show, and the button that stops it.
 *
 * Plain HTML built here rather than a second page in the viewer bundle. It has
 * to work when the viewer has not been built -- that is one of the moments you
 * most want to see what is running -- and a page whose whole job is to list
 * files and hold one button does not need a framework to do it.
 *
 * It is also the answer to "how do I stop this" for anyone who never reads a
 * command's help. `diagramos stop` remains the way to stop every service at
 * once; this stops the one you are looking at.
 */

/** Escapes text for HTML. The board names come from the filesystem, not from us. */
function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #1b1b1f; --muted: #6b6b76;
  --line: #e4e4ea; --card: #fafafc; --accent: #5b57d1;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #17171b; --fg: #ececf1; --muted: #9a9aa6;
          --line: #2c2c33; --card: #1e1e24; --accent: #9b97ff; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 3rem 1.5rem; background: var(--bg); color: var(--fg);
       font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 46rem; margin: 0 auto; }
h1 { font-size: 1.35rem; margin: 0 0 .35rem; }
.sub { color: var(--muted); margin: 0 0 2rem; }
ul { list-style: none; margin: 0; padding: 0; }
li { border: 1px solid var(--line); border-radius: 10px; background: var(--card); margin-bottom: .6rem; }
li a { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline;
       padding: .85rem 1rem; color: inherit; text-decoration: none; }
li a:hover { border-color: var(--accent); }
.name { font-weight: 550; }
.tag { color: var(--accent); font-size: .8rem; }
footer { margin-top: 2.5rem; padding-top: 1.25rem; border-top: 1px solid var(--line);
         display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
.meta { color: var(--muted); font-size: .85rem; }
button { font: inherit; padding: .5rem .9rem; border-radius: 8px; cursor: pointer;
         border: 1px solid var(--line); background: transparent; color: var(--fg); }
button:hover:not(:disabled) { border-color: #d2504a; color: #d2504a; }
button:disabled { opacity: .55; cursor: default; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
.empty { color: var(--muted); }
`;

const SCRIPT = `
const fmt = (iso) => {
  const started = Date.parse(iso);
  if (Number.isNaN(started)) return "";
  const s = Math.max(0, Math.round((Date.now() - started) / 1000));
  if (s < 90) return s + " seconds";
  if (s < 5400) return Math.round(s / 60) + " minutes";
  if (s < 172800) return Math.round(s / 3600) + " hours";
  return Math.round(s / 86400) + " days";
};

async function load() {
  const data = await (await fetch("/api/boards", { cache: "no-store" })).json();
  const list = document.querySelector("#boards");
  document.querySelector("#project").textContent = data.root ?? "no project";
  document.querySelector("#meta").textContent =
    "pid " + data.pid + " · port " + data.port + " · up " + fmt(data.startedAt);
  if (!data.boards.length) {
    list.innerHTML = '<li><a class="empty">No boards in this project yet.</a></li>';
    return;
  }
  // Built as nodes rather than as a string: a board name comes from the
  // filesystem, and a filename is allowed to contain angle brackets.
  list.replaceChildren(...data.boards.map((b) => {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = b.url;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = b.name;
    link.append(name);
    if (b.current) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "showing now";
      link.append(tag);
    }
    item.append(link);
    return item;
  }));
}

document.querySelector("#stop").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Stopping…";
  try {
    // The header is what tells the service this came from its own page rather
    // than from some other site the browser happens to have open.
    await fetch("/api/shutdown", { method: "POST", headers: { "x-diagramos": "stop" } });
  } catch {}
  document.querySelector("#after").hidden = false;
  button.textContent = "Stopped";
});

load().catch(() => {
  document.querySelector("#boards").innerHTML =
    '<li><a class="empty">This board service is not answering. It may already be stopped.</a></li>';
});
`;

export function boardsPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Boards</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>Boards</h1>
  <p class="sub"><code id="project">…</code></p>
  <ul id="boards"><li><a class="empty">Loading…</a></li></ul>
  <footer>
    <span class="meta" id="meta"></span>
    <button id="stop" type="button">Stop this board service</button>
  </footer>
  <p class="meta" id="after" hidden>
    Stopped. Your diagrams are files in the repository and are untouched —
    run <code>${escape("diagramos board")}</code> to look again.
  </p>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
