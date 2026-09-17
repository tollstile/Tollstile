#!/usr/bin/env bash
# Installs the release the way users will, into an empty project outside the workspace, and runs
# scripts/release/smoke.mjs against it.
#
#   scripts/release/pack-smoke.sh            # packed tarballs from this checkout
#   scripts/release/pack-smoke.sh 0.1.2      # the given version from the npm registry
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
version="${1:-}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

packages=$(node --input-type=module -e "import { publishablePackages } from '$root/scripts/release/packages.mjs'; console.log(publishablePackages().map(({ manifest }) => manifest.name).join(' '))")
peers="hono@^4.6.0 express@^5.0.0 @modelcontextprotocol/sdk@^1.23.0"

mkdir -p "$work/app" "$work/tarballs"
cd "$work/app"
npm init -y > /dev/null
npm pkg set type=module > /dev/null

if [ -z "$version" ]; then
  for dir in "$root"/packages/*/; do
    if [ "$(node -p "require('$dir/package.json').private === true")" = "true" ]; then continue; fi
    (cd "$dir" && pnpm pack --pack-destination "$work/tarballs" > /dev/null)
  done
  echo "Installing packed tarballs: $(ls "$work/tarballs" | tr '\n' ' ')"
  npm install --no-audit --no-fund "$work"/tarballs/*.tgz $peers
else
  specs=""
  for name in $packages; do specs="$specs $name@$version"; done
  echo "Installing from npm:$specs"
  npm install --no-audit --no-fund $specs $peers
fi

cp "$root/scripts/release/smoke.mjs" ./smoke.mjs
node smoke.mjs

# The CLI loads and explains itself.
npx --no-install tollstile --help | grep -q "tollstile reconcile"
echo "tollstile CLI answered."

# The project generator produces a project whose dependencies name this release.
npx --no-install create-tollstile smoke-project > /dev/null
test -f smoke-project/package.json
echo "create-tollstile generated a project."
