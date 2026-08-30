#!/bin/sh
#
# The drift check as a Stop hook, for every project this plugin is installed in.
#
# For most of this project's life the hook was documented as opt-in and shipped
# with nothing: a plugin hook fires in every project someone installs into, most
# of which have no diagrams, and paying for that seemed worse than asking. The
# consequence was that the one feature keeping a diagram honest was the one
# feature every user had to wire up by hand, after reading a design doc. Nobody
# was going to.
#
# So it ships, and the cost is paid down here instead.

set -u

# Hooks are handed the project directory. Falling back to the working directory
# rather than guessing keeps this working if that ever stops being set, and the
# check itself reads the tree from the working directory.
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

# The guard, and the whole reason this can ship at all.
#
# Measured in a git repo with no diagrams: `npx -y diagramos drift --hook` costs
# ~260ms warm and ~540ms cold, and nearly all of that is npx and node starting
# up -- the check itself finds no diagram directory and stops immediately. There
# is nothing left to optimise inside it, so the saving has to happen before it is
# launched. A project with no diagrams now pays a directory test.
#
# Both tests are needed. The diagram directory is configurable through
# .diagramos.json, so testing only the default would silently skip every project
# that moved it -- and silently checking nothing while appearing to work is the
# exact failure this check exists to catch.
[ -d docs/diagrams ] || [ -f .diagramos.json ] || exit 0

# Pinned for the reason .claude-plugin/plugin.json is pinned: installing a plugin
# copies files into a cache without running npm install, so a cached plugin must
# not silently pick up a newer server than it shipped against.
# tests/plugin-hook.test.ts fails if this drifts from the manifest.
#
# `|| exit 0` swallows a launch failure rather than a finding: --hook always
# exits 0 once it has delivered its notice, so a non-zero status here means npx
# could not fetch or run the package at all -- offline, a broken cache, a
# half-installed npm. Claude Code renders a non-zero hook as
# "Stop hook error: Failed", and a project that cannot reach npm would show that
# on every single turn forever. That is how a check gets switched off. Somebody
# who wants the error can run the command by hand and read it in full.
#
# Not `exec`: it would replace this shell, so npx's exit status would become the
# hook's and the `|| exit 0` would never run.
npx -y diagramos@0.2.0-rc.3 drift --hook || exit 0
