#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
test_root=$(mktemp -d /tmp/lmm-browser-e2e.XXXXXX)
server_port=18766
cdp_port=19223
server_pid=''
browser_pid=''

cleanup() {
    status=$?
    set +e
    [[ -z "$browser_pid" ]] || kill "$browser_pid" 2>/dev/null || true
    [[ -z "$server_pid" ]] || kill "$server_pid" 2>/dev/null || true
    [[ -z "$browser_pid" ]] || wait "$browser_pid" 2>/dev/null || true
    [[ -z "$server_pid" ]] || wait "$server_pid" 2>/dev/null || true
    if [[ $status -ne 0 ]]; then
        echo "--- server log ---" >&2
        tail -80 "$test_root/server.log" >&2 2>/dev/null || true
        echo "--- chromium log ---" >&2
        tail -80 "$test_root/chromium.log" >&2 2>/dev/null || true
    fi
    rm -rf "$test_root"
    exit "$status"
}
trap cleanup EXIT

mkdir -p "$test_root/game" "$test_root/downloads" "$test_root/chromium"
printf '%s\n' 'return {}' > "$test_root/game/custom.lua"
zip -q -j "$test_root/custom-test.zip" "$test_root/game/custom.lua"
printf '%s\n' 'function love.load() end' > "$test_root/game/main.lua"
printf '%s\n' 'test-version' > "$test_root/game/version.jkr"
printf '%s\n' 'function love.conf(t) t.identity = "lmm-e2e" end' > "$test_root/game/conf.lua"
(
    cd "$test_root/game"
    zip -q "$test_root/test-game.love" main.lua version.jkr conf.lua
)

python3 -m http.server "$server_port" --directory "$repo_root" >"$test_root/server.log" 2>&1 &
server_pid=$!

chromium \
    --headless \
    --disable-gpu \
    --disable-dev-shm-usage \
    --no-sandbox \
    --remote-debugging-port="$cdp_port" \
    --user-data-dir="$test_root/chromium" \
    about:blank >"$test_root/chromium.log" 2>&1 &
browser_pid=$!

ready=false
for _ in $(seq 1 100); do
    if curl -fsS "http://127.0.0.1:$server_port/" >/dev/null \
        && curl -fsS "http://127.0.0.1:$cdp_port/json/list" >/dev/null; then
        ready=true
        break
    fi
    sleep 0.1
done
if [[ $ready != true ]]; then
    echo "Local server or Chromium did not become ready" >&2
    exit 1
fi

LMM_TEST_GAME="$test_root/test-game.love" \
LMM_TEST_CUSTOM_MOD="$test_root/custom-test.zip" \
LMM_TEST_DOWNLOADS="$test_root/downloads" \
LMM_TEST_URL="http://127.0.0.1:$server_port/" \
CDP_PORT="$cdp_port" \
node "$repo_root/tests/browser-e2e.mjs"

apk="$test_root/downloads/game.apk"
test -s "$apk"
unzip -tq "$apk" >/dev/null
unzip -Z1 "$apk" | grep -Fx 'assets/lmm_bundled_mods/manifest.txt' >/dev/null
unzip -Z1 "$apk" | grep -Fx 'assets/lmm_bundled_mods/files.txt' >/dev/null
for mod in Steamodded Handy RunReviewer Brainstorm JokerDisplay Amulet custom-test; do
    unzip -Z1 "$apk" | grep -F "assets/lmm_bundled_mods/$mod/" >/dev/null
done
expected_manifest=$'Steamodded\nHandy\nRunReviewer\nBrainstorm\nJokerDisplay\nAmulet\ncustom-test'
test "$(unzip -p "$apk" assets/lmm_bundled_mods/manifest.txt)" = "$expected_manifest"
unzip -p "$apk" assets/lmm_bundled_mods/files.txt | grep -Fx 'custom-test/custom.lua' >/dev/null
unzip -p "$apk" assets/main.lua | grep -F 'LMM_copy_bundled_mods' >/dev/null
unzip -p "$apk" assets/main.lua | luac -p -
unzip -p "$apk" assets/main.lua > "$test_root/injected-main.lua"
lua "$repo_root/tests/mod-installer-runtime.lua" "$test_root/injected-main.lua"

echo "Browser E2E passed: APK mod selection, custom ZIP timing, and installer retry/persistence."
