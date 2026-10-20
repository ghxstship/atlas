#!/bin/sh
# A59 visual review: prebuilds Compass for iOS in this worktree and installs its pods.
# The generated apps/compass/ios folder is gitignored.
set -u
root="$(cd "$(dirname "$0")/../../../.." && pwd)"
logs="$root/legal/qa/visual-review/shots/logs"
mkdir -p "$logs"
cd "$root/apps/compass" || exit 1
CI=1 pnpm exec expo prebuild -p ios --no-install > "$logs/compass-prebuild.log" 2>&1
echo "prebuild=$?"
cd ios || exit 1
LANG=en_US.UTF-8 PATH="$HOME/.local/bin:$PATH" pod install > "$logs/compass-pod.log" 2>&1
echo "pod=$?"
