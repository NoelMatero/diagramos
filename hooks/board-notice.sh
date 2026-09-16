#!/bin/sh
#
# Says, at the start of a session, that a board server is still running (#285).
#
# A board server outlives the session that opened it, and that stays the
# default: a page somebody is reading should not close because a terminal did.
# What was missing is being told. On 2026-09-16 the first sign of a leftover
# server was a red "this page is out of date" on a board that was fine.
#
# This only tells. It never stops anything, and it never exits non-zero: a
# failing hook shows as an error on every session start, which is how a feature
# gets switched off (the same reasoning as drift.sh).

set -u

# Pinned like drift.sh. tests/board-notice-hook.test.ts fails if this drifts
# from the plugin manifest.
INSTALLED=0.2.0-rc.6

REGISTRY="${DIAGRAMOS_STATE_DIR:-${HOME:-}/.diagramos/servers}"

# The guard: no server entry, no node. A running server writes one file per
# process here, so an empty glob is the common case and costs a directory read.
set -- "$REGISTRY"/*.json
[ -e "$1" ] || exit 0

node "$(dirname "$0")/board-notice.mjs" "$INSTALLED" "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null || exit 0
