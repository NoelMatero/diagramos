#!/bin/sh
# bench-planted-draw.sh <index> [work dir]
#
# Draws one board of #296's test set with Haiku, isolated from any installed
# diagramos plugin, and copies it to bench/boards/<project>/<topic>.excalidraw.
# Run once per entry of bench/scopes.json; the boards are then checked in and
# nothing downstream calls a model again. See the harness notes in
# bench/README.md.
#
#   sh scripts/bench-planted-draw.sh 0
#
# Needs a built CLI (`npm run build:cli`) and the pinned clones in .corpus.
set -eu
REPO=$(cd "$(dirname "$0")/.." && pwd)
CORPUS=${CORPUS:-/Users/noelmatero/board-ai/.corpus}
WORK=${2:-${TMPDIR:-/tmp}/bench-planted}
i=$1
row=$(python3 -c "import json,sys;print(json.dumps(json.load(open('$REPO/bench/scopes.json'))[int(sys.argv[1])]))" "$i")
get() { python3 -c "import json,sys;print(json.loads(sys.argv[1])[sys.argv[2]])" "$row" "$1"; }
project=$(get project); topic=$(get topic); scope=$(get scope); ask=$(get ask)

plugin="$WORK/plugin"
if [ ! -f "$plugin/.claude-plugin/plugin.json" ]; then
  mkdir -p "$plugin/.claude-plugin" "$plugin/skills"
  cp -R "$REPO/skills/diagram" "$plugin/skills/diagram"
  cat > "$plugin/.claude-plugin/plugin.json" <<JSON
{"name":"diagramos","version":"0.0.0-bench","mcpServers":{"diagramos":{"command":"node","args":["$REPO/out/cli/diagramos.mjs"],"env":{"DIAGRAMOS_MCP_ROOT":"\${CLAUDE_PROJECT_DIR}","DIAGRAMOS_STATE_DIR":"$WORK/state"}}}}
JSON
fi

base="$WORK/base/$project"
if [ ! -d "$base" ]; then
  mkdir -p "$base"
  rsync -a --exclude .git --exclude node_modules --exclude target --exclude .venv \
    --exclude docs --exclude .diagramos --exclude .claude "$CORPUS/$project/" "$base/"
  (cd "$base" && git init -q)
fi
run="$WORK/runs/$i-$project-$topic"
rm -rf "$run"; mkdir -p "$run"
cp -Rc "$base" "$run/proj" 2>/dev/null || cp -R "$base" "$run/proj"

cat > "$run/prompt.txt" <<P
Read the code under $scope and draw one diagram with the diagramos MCP tools showing $ask.
Save it as docs/diagrams/$topic.excalidraw.
Start with survey_scope on $scope. Keep the board to about 6 to 12 boxes, each anchored at the function or type it stands for (path#symbol).
Where you read the line that shows how two boxes relate, put the matching claim on the arrow, as the diagram skill's claims table describes.
Do not open the board and do not render it.
P

cd "$run/proj"
env -u ANTHROPIC_API_KEY timeout 900 claude -p --model haiku \
  --plugin-dir "$plugin" \
  --settings '{"enabledPlugins":{"diagramos@diagramos":false}}' \
  --output-format stream-json --verbose --max-budget-usd "${BUDGET:-0.40}" \
  --allowedTools Read Glob Grep Skill "Bash(ls:*)" "Bash(find:*)" "Bash(wc:*)" "Bash(cat:*)" "Bash(head:*)" "Bash(grep:*)" "Bash(mkdir:*)" mcp__plugin_diagramos_diagramos \
  --disallowedTools mcp__plugin_diagramos_diagramos__open_board mcp__plugin_diagramos_diagramos__render_diagram \
  <"$run/prompt.txt" >"$run/out.jsonl" 2>"$run/err.txt" || true

cost=$(python3 -c "
import json,sys
c=0
for l in open(sys.argv[1]):
    try: d=json.loads(l)
    except Exception: continue
    if d.get('type')=='result': c=d.get('total_cost_usd',0)
print(c)" "$run/out.jsonl")
board="docs/diagrams/$topic.excalidraw"
if [ -f "$board" ]; then
  mkdir -p "$REPO/bench/boards/$project"
  cp "$board" "$REPO/bench/boards/$project/$topic.excalidraw"
  echo "$i $project/$topic drawn cost=$cost"
else
  echo "$i $project/$topic NO BOARD cost=$cost"
fi
