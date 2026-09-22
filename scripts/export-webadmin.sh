#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
webadmin_root=${1:-/home/pengo/Dev/webadmin}
target="$webadmin_root/static/balatro-mobile-maker"

if [[ ! -f "$webadmin_root/package.json" || ! -f "$webadmin_root/wrangler.jsonc" ]]; then
    echo "Not a webadmin project: $webadmin_root" >&2
    exit 1
fi

for required in base.apk base.ipa debug-cert.pem; do
    if [[ ! -f "$repo_root/$required" ]]; then
        echo "Missing required asset: $repo_root/$required" >&2
        exit 1
    fi
done

(
    cd "$repo_root/bindgen"
    RUSTFLAGS='--cfg getrandom_backend="wasm_js"' wasm-pack build --target web
)

staging_dir=$(mktemp -d /tmp/balatro-mobile-maker-export.XXXXXX)
trap 'rm -rf "$staging_dir"' EXIT

mkdir -p "$staging_dir/js/pkg"
cp "$repo_root/index.html" "$repo_root/faq.html" "$repo_root/base.apk" \
    "$repo_root/base.ipa" "$repo_root/debug-cert.pem" "$staging_dir/"
cp -a "$repo_root/css" "$repo_root/img" "$repo_root/mods" "$staging_dir/"
cp "$repo_root"/js/*.js "$staging_dir/js/"

# wasm-pack generates pkg/.gitignore containing '*'. Never export it: webadmin
# intentionally commits the generated JS bindings and WASM binary.
rsync -a --exclude='.gitignore' "$repo_root/bindgen/pkg/" "$staging_dir/js/pkg/"
mkdir -p "$target"
rsync -a --delete "$staging_dir/" "$target/"

(
    cd "$webadmin_root"
    npm run build
)

echo "Exported Balatro Mobile Maker to $target"
