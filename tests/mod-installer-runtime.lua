-- Run against main.lua extracted from a browser-generated APK.
local main_path = assert(arg[1], "expected path to injected main.lua")
local source = {}
local saved = {}
local directories = { Mods = true }
local fail_write = nil

love = { filesystem = {} }
function love.filesystem.read(path)
    return source[path] or saved[path]
end
function love.filesystem.write(path, data)
    if path == fail_write then return false end
    saved[path] = data
    return true
end
function love.filesystem.getInfo(path, kind)
    local info
    if source[path] or saved[path] then info = { type = "file" } end
    if directories[path] then info = { type = "directory" } end
    if kind and info and kind ~= info.type then return nil end
    return info
end
function love.filesystem.createDirectory(path)
    directories[path] = true
    return true
end
function love.filesystem.remove(path)
    if saved[path] == nil then return false end
    saved[path] = nil
    return true
end

local function install(version, files)
    source["lmm_bundled_mods/version.txt"] = version
    source["lmm_bundled_mods/files.txt"] = table.concat(files, "\n")
    source["lmm_bundled_mods/manifest.txt"] = "A\nB"
    dofile(main_path)
end

source["lmm_bundled_mods/A/one.lua"] = "first"
source["lmm_bundled_mods/A/two.lua"] = "second"
install("v1", { "A/one.lua", "A/two.lua" })
assert(saved["Mods/A/one.lua"] == "first")
assert(saved["Mods/.copied_version"] == "v1")

saved["Mods/A/config.lua"] = "user settings"
source["lmm_bundled_mods/A/one.lua"] = "updated"
source["lmm_bundled_mods/B/three.lua"] = "third"
install("v2", { "A/one.lua", "B/three.lua" })
assert(saved["Mods/A/config.lua"] == "user settings", "mod settings were removed")
assert(saved["Mods/A/one.lua"] == "updated")
assert(saved["Mods/A/two.lua"] == nil, "obsolete bundled file remained")
assert(saved["Mods/B/three.lua"] == "third")
assert(saved["Mods/.copied_version"] == "v2")

source["lmm_bundled_mods/B/three.lua"] = "retry data"
fail_write = "Mods/B/three.lua"
install("v3", { "A/one.lua", "B/three.lua" })
assert(saved["Mods/.copied_version"] == "v2", "failed copy was marked complete")
fail_write = nil
install("v3", { "A/one.lua", "B/three.lua" })
assert(saved["Mods/B/three.lua"] == "retry data", "failed copy was not retried")
assert(saved["Mods/.copied_version"] == "v3")

print("Injected mod installer preserves settings and retries failed copies.")
