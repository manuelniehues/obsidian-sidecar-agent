#!/bin/zsh
# Builds, checks and publishes a GitHub release for the version in manifest.json.
#   node scripts/version.mjs 1.0.1   # bump the version first
#   scripts/release.sh               # commit, tag, push, release with main.js, manifest.json, styles.css
set -euo pipefail
cd "${0:A:h}/.."
# Real Node for the test runner (`node` in PATH can be a Bun shim, which has no `node --test`)
NODE=$(for n in /opt/homebrew/bin/node /usr/local/bin/node; do [[ -x $n ]] && echo $n && break; done)
NODE=${NODE:-node}
V=$(node -p "require('./manifest.json').version")
node scripts/check-i18n.mjs
npx eslint src
"$NODE" --test tests/
# Do the parsers still understand the sessions of the installed Claude Code / Antigravity?
"$NODE" scripts/compat-check.mjs
npm run build
git add -A
git diff --cached --quiet || git commit -m "Release $V"
git tag -a "$V" -m "$V"
git push origin main "$V"
gh release create "$V" dist/main.js dist/manifest.json dist/styles.css --title "$V" --notes "$(awk -v v="## $V" '$0==v{f=1;next} /^## /{f=0} f' CHANGELOG.md)"
echo "Released $V"
