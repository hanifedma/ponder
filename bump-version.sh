#!/usr/bin/env bash
# Run this before deploying: bumps the version in index.html (app-version meta +
# the ?v= cache-busting on styles.css/app.js) and version.json, all together.
# Then commit & push. Open tabs poll version.json and offer a reload.
set -e
cd "$(dirname "$0")"
cur=$(grep -oE '"version"[: ]+"[0-9]+"' version.json | grep -oE '[0-9]+' | head -1)
next=$((cur + 1))
sed -i -E "s/(name=\"app-version\" content=\")[0-9]+(\")/\1${next}\2/" index.html
sed -i -E "s/(styles\.css\?v=)[0-9]+/\1${next}/" index.html
sed -i -E "s/(app\.js\?v=)[0-9]+/\1${next}/" index.html
printf '{ "version": "%s" }\n' "$next" > version.json
echo "Version bumped: $cur -> $next"
echo "Now:  git add -A && git commit -m '...' && git push"
