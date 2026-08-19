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
/* A board with no project is named by its full path, which can be longer than
   the row; breaking it anywhere beats it deciding the width of the page. */
.name { font-weight: 550; overflow-wrap: anywhere; }
h2 { font-size: .8rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
     color: var(--muted); margin: 1.75rem 0 .6rem; }
h2:first-of-type { margin-top: 0; }
/* Never wraps: two words on two lines next to a filename reads as part of the
   name rather than as a label about it. */
.tag { color: var(--accent); font-size: .8rem; white-space: nowrap; flex-shrink: 0; }
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

const short = (p) => p.split("/").filter(Boolean).slice(-2).join("/");

async function load() {
  const data = await (await fetch("/api/boards", { cache: "no-store" })).json();
  const list = document.querySelector("#boards");
  const projects = data.roots && data.roots.length ? data.roots : [data.root].filter(Boolean);
  document.querySelector("#project").textContent =
    projects.length > 1 ? projects.length + " projects" : projects[0] ?? "no project";
  document.querySelector("#meta").textContent =
    "pid " + data.pid + " · port " + data.port + " · up " + fmt(data.startedAt);
  if (!data.boards.length) {
    list.replaceChildren(Object.assign(document.createElement("li"), { className: "empty" }));
    list.firstChild.textContent = "No boards yet.";
    return;
  }
  /*
   * Grouped by project once there is more than one, because a flat list of forty
   * boards across four repositories is the same wall of names the command line
   * gave you. With a single project the heading would say nothing, so it is left
   * off.
   */
  const groups = new Map();
  for (const b of data.boards) {
    const key = b.project || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }

  // Built as nodes rather than as a string: a board name comes from the
  // filesystem, and a filename is allowed to contain angle brackets.
  const item = (b) => {
    const node = document.createElement("li");
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
    node.append(link);
    return node;
  };

  const nodes = [];
  for (const [project, entries] of groups) {
    if (groups.size > 1) {
      const heading = document.createElement("h2");
      heading.textContent = project ? short(project) : "elsewhere";
      heading.title = project;
      nodes.push(heading);
    }
    nodes.push(...entries.map(item));
  }
  list.replaceChildren(...nodes);
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
