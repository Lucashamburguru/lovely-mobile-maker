import init, { zip_open, zip_read_file, entry_names, axml_to_xml, xml_to_axml, write_file, zip_save, zip_save_and_sign_v2 } from "./pkg/mbf_bindgen.js";
import { modifyManifest, modifyInfoPlist } from "./manifest.js";
import { downloadBlob, nameToIdentity, asyncTimeout, getMainDir } from "./util.js";
import { makeIconList, getImageForIcon, icons, getQualities } from "./icon.js";
import { imgToPNGOfSize } from "./img.js";
import sharedState from "./state.js";
import * as platformValues from "./platform.js";

const wasmReady = init();
const liveSteps = [];
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const identityRegex = /t.identity\s*=\s*['"]([^'"]+)/;
const nameRegex = /^(.+?)(?:\.[^.]+)?$/;

function safeModName(name) {
    const sanitized = name.replace(/[^a-zA-Z0-9._ -]/g, "_").trim();
    return sanitized && sanitized !== "." && sanitized !== ".." ? sanitized : null;
}

function normalizeZipEntryPath(path) {
    if (/[\x00-\x1f\x7f]/.test(path)) return null;
    const parts = path.replaceAll("\\", "/").split("/").filter(part => part && part !== ".");
    if (parts.length === 0 || parts.some(part => part === "..")) return null;
    return parts.join("/");
}

const baseID = "systems.shorty.lmm";
const balatroPreset = {
    identity: "balatro",
    name: "Balatro",
};

const bundledMods = [
    { id: "steamodded", name: "Steamodded", filename: "Steamodded.zip" },
    { id: "mobilepatches", name: "MobilePatches", filename: "MobilePatches.zip" },
    { id: "handy", name: "Handy", filename: "Handy.zip", requiresSteamodded: true },
    { id: "runreviewer", name: "RunReviewer", filename: "RunReviewer.zip", requiresSteamodded: true },
    { id: "brainstorm", name: "Brainstorm", filename: "Brainstorm.zip", archiveRoot: "Brainstorm-Rerolled-main/Brainstorm/" },
    { id: "jokerdisplay", name: "JokerDisplay", filename: "JokerDisplay.zip", requiresSteamodded: true },
    { id: "amulet", name: "Amulet", filename: "Amulet.zip", requiresSteamodded: true },
];

class Step {
    constructor(element, index) {
	this.element = element;
	this.resetCollapsed = element.classList.contains("collapsed");
	this.index = index;
	this.status = document.createElement("p");
	this.status.classList.add("status");
	this.element.append(this.status);
    }

    updateStatus(content) {
	this.status.innerText = content;
	if (content)
	    console.log("[Status update]", content);
    }

    get next() {
	return liveSteps[this.index + 1];
    }

    get previous() {
	return liveSteps[this.index - 1];
    }

    done() {
	if (!this.next) return
	this.next.clear();
	this.next.ready();
    }

    clear() {
	this.status.innerText = "";
    }

    reset() {
	this.clear();
	this.next?.reset();
	if (this.resetCollapsed)
	    this.element.classList.add("collapsed");
    }

    ready() {
	this.element.classList.remove("collapsed");
    }
}

class GameStep extends Step {
    constructor(element, index) {
	super(element, index)
	this.file = element.querySelector("#gamefile");
	this.clear();
	this.file.addEventListener("change", this.handleFile.bind(this));
    }

    clear() {
	this.file.value = "";
	sharedState.gameData = null;
    }

    handleFile(event) {
	const file = event.target.files[0];
	this.next?.reset();

	if (!file) {
	    this.updateStatus("No file selected. Please choose a file.");
	    return;
	}

	this.updateStatus("Checking file...");
	const reader = new FileReader();
	reader.onload = () => {
	    wasmReady.then(() => {
		sharedState.gameData = this.processGame(new Uint8Array(reader.result), file.name);
		document.body.classList[sharedState.gameData.isBalatro ? "add" : "remove"]("game-balatro");
		this.done();
	    }).catch(e => {
		console.error(e)
		this.updateStatus("An error occurred: " + e)
	    });
	};
	reader.onerror = () => {
	    this.updateStatus("Error reading the file. Please try again.");
	};
	reader.readAsArrayBuffer(file);
    };

    processGame(data, name) {
	let zip
	try {
	    zip = zip_open(data);
	} catch (e) {
	    // Fused(?)
	    let cdOffset
	    for (let i = 0; i < data.length; i++) {
		if (data[i] === 0x50 && data[i + 1] === 0x4B && data[i + 2] === 0x01 && data[i + 3] === 0x02) {
		    cdOffset = i;
		    break
		}
	    }
	    if (cdOffset === null) throw e;
	    let givenOffset;
	    for (let i = cdOffset; i < data.length; i++) {
		if (data[i] === 0x50 && data[i + 1] === 0x4B && data[i + 2] === 0x05 && data[i + 3] === 0x06) {
		    const byte1 = data[i + 19];
		    const byte2 = data[i + 18];
		    const byte3 = data[i + 17];
		    const byte4 = data[i + 16];

		    const uint32 = ((byte1 << 24) | (byte2 << 16) | (byte3 << 8) | byte4) >>> 0;
		    givenOffset = uint32;
		    break
		}
	    }
	    if (givenOffset === null) throw e;
	    const diff = cdOffset - givenOffset;
	    data = data.slice(diff)
	    zip = zip_open(data)
	}
	const files = entry_names(zip);

	let isLove = false, isBalatro = false, hasConf = false;
	for (const f of files) {
	    if (f === "main.lua") {
		isLove = true;
		if (isBalatro && hasConf) break;
	    } else if (f === "version.jkr") {
		isBalatro = true;
		if (isLove && hasConf) break;
	    } else if (f === "conf.lua") {
		hasConf = true;
		if (isLove && isBalatro) break;
	    }
	}
	if (!isLove) throw "Provided file does not appear to be a valid love game (no main.lua)"
	this.updateStatus("Valid File Passed!")
	return {
	    zip, isBalatro, isLove, files, hasConf, name, data,
	}
    }
}

class PlatformStep extends Step {
    constructor(e, i) {
	super(e, i);
	const select = e.querySelector("select");
	this.select = select;
	this.select.value = "";
	select.addEventListener("change", this.updateSelect.bind(this));
    }

    clear() {
	super.clear();
	this.select.selectedIndex = 0;
    }

    updateSelect() {
	const value = this.select.value;
	sharedState.platform = value;
	sharedState.platformValues = platformValues[value];
	sharedState.apk = null;
	const classList = document.body.classList;
	for (const option of this.select.options) {
	    if (option.value === value) classList.add(`platform-${option.value}`);
	    else classList.remove(`platform-${option.value}`);
	}
	this.next?.reset();
	this.done();
    }
}

class DownloadStep extends Step {
    constructor(e, i) {
	super(e,i);
    }
    async ready() {
	super.ready();
	try {
	    const type = sharedState.platform === "ios" ? "ipaData" : "apkData";
	    if (!sharedState[type]) {
		this.updateStatus("Downloading base app...");
		const res = await fetch(this.basename + sharedState.platformValues.ext)
		    .then(async r => {
			if(r.ok) return new Uint8Array(await r.arrayBuffer());
			throw new Error("Failed to fetch " + this.basename + sharedState.platformValues.ext +": " + r.status + ": " + r.statusText)
		    });
		sharedState[type] = res
	    }
	    if (!sharedState.cert) {
		this.updateStatus("Downloading cert...");
		const res = await fetch("debug-cert.pem")
		    .then(async r => {
			if(r.ok) return new Uint8Array(await r.arrayBuffer());
			throw new Error("Failed to fetch debug-cert.pem: " + r.status + ": " + r.statusText)
		    });
		sharedState.cert = res
	    }
	    this.updateStatus("Downloading Complete");
	    this.done();
	} catch (e) {
	    console.error(e);
	    this.updateStatus("An error ocurred: " + e);
	    const button = document.createElement("button");
	    button.innerText = "Retry";
	    button.addEventListener("click", () => {
		this.ready();
	    });
	    this.status.appendChild(document.createElement("br"));
	    this.status.appendChild(button);
	}
    }

    get basename() {
	const params = new URLSearchParams(window.location.search);
	return safeModName(params.get("baseOverride") || "base") || "base";
    }
}

class MetaStep extends Step {
    constructor(e,i) {
	super(e,i);
	this.name = document.getElementById("meta-name");
	this.bundle = document.getElementById("meta-bundle");
	this.icon = document.getElementById("meta-icon");
	this.submit = document.getElementById("meta-ready");
	this.iconList = document.querySelector(".meta-icon-list");
	this.iconPicker = document.querySelector(".meta-icon-picker");
	this.customIcon = document.querySelector(".meta-custom-icon");
	this.submit.addEventListener("click", () => this.doneButton());
	this.icon.addEventListener("click", () => this.toggleIconPicker());
    }

    async ready() {
	try {
	    super.ready();
	    let varState = {}
	    const game = sharedState.gameData;
	    this.iconPicker.classList.add("hidden");
	    if (game.isBalatro) {
		varState = balatroPreset;
	    } else {
		if(game.hasConf) {
		    const conf = decoder.decode(zip_read_file(game.zip, "conf.lua"));
		    const identity = conf.match(identityRegex);
		    if (identity) varState.identity = identity[1];
		}
		varState.name = game.name.match(nameRegex)?.[1];
		if (!varState.identity && varState.name) varState.identity = nameToIdentity(varState.name);
	    }
	    this.name.value = varState.name || "Lovely Mobile Maker";
	    this.bundle.value = baseID + (varState.identity ? "." + varState.identity : "");
	    this.prepared = this.prepareAPK();
	    await this.prepared;
	    if(game.isBalatro) sharedState.icon = 1;
	    else sharedState.icon = 0;
	    this.iconList.innerHTML = "";
	    makeIconList(this.iconList, this);
	} catch(e) {
	    console.error(e);
	    this.updateStatus("An error occured!?!?!? " + e);
	}
    }

    clear() {
	super.clear();
	this.iconPicker.classList.add("hidden");
	sharedState.meta = null;
    }

    async checkIcon() {
	sharedState.iconImg = null;
	const icon = icons[sharedState.icon];
	if (icon.type === "internal") {
	    return true
	}
	const img = await getImageForIcon(icon).catch(e => {
	    console.error("Error getting icon", e);
	    return null
	});
	if (!img) return;
	sharedState.iconImg = img;
	return true
    }

    async doneButton() {
	this.prepared = this.prepareAPK();
	await this.prepared;
	this.updateStatus("");
	if (!this.bundle.checkValidity()) return this.updateStatus("Cannot continue, invalid bundle id");
	if (!(await this.checkIcon())) return this.updateStatus("Cannot continue, invalid icon");
	this.iconPicker.classList.add("hidden");
	this.next.reset();
	await this.prepared
	const meta = {};
	meta.name = this.name.value || null;
	meta.bundle = this.bundle.value;
	sharedState.meta = meta;
	this.done();
    }

    async prepareAPK() {
	this.updateStatus(`Preparing ${sharedState.platform === "ios" ? "IPA" : "APK"}...`);
	await asyncTimeout();
	const type = sharedState.platform === "ios" ? "ipaData" : "apkData";
	if (sharedState.apk) sharedState.apk.free();
	sharedState.apk = zip_open(sharedState[type]);
	this.updateStatus("");
    }

    async updateSelectedIcon(icon) {
	const img = await getImageForIcon(icon).catch(console.error);
	if (img)
	    this.icon.replaceChildren(img);
	else
	    this.icon.innerText = ""
    }

    toggleIconPicker() {
	this.iconPicker.classList.toggle("hidden");
    }

}

class ModStep extends Step {
    constructor(e, i) {
	super(e, i);
	this.btnReady = document.getElementById("mods-ready");
	this.btnReady.addEventListener("click", () => this.handleContinue());
	this.selectionStatus = document.getElementById("mods-selection-status");
	this.checkboxes = Object.fromEntries(bundledMods.map(mod => [mod.id, document.getElementById(`mod-${mod.id}`)]));
	for (const checkbox of Object.values(this.checkboxes)) {
	    checkbox.addEventListener("change", event => this.handleSelectionChange(event));
	}

	this.customInput = document.getElementById("custom-mods");
	this.customList = document.getElementById("custom-mods-list");
	this.customInput.addEventListener("change", (event) => this.handleCustomMods(event));

	this.customMods = [];
	this.pendingCustomReads = 0;
	this.readGeneration = 0;
	this.isDownloading = false;
	this.customReadError = "";
    }

    clear() {
	super.clear();
	this.readGeneration++;
	this.pendingCustomReads = 0;
	this.isDownloading = false;
	this.customReadError = "";
	this.customMods = [];
	this.customList.innerHTML = "";
	this.customInput.value = "";
	this.selectionStatus.textContent = "";
	this.updateContinueState();
	sharedState.mods = [];
    }

    ready() {
	super.ready();
	this.clear();
	for (const mod of bundledMods) this.checkboxes[mod.id].checked = mod.id === "steamodded";
    }

    updateContinueState() {
	this.btnReady.disabled = this.pendingCustomReads > 0 || this.isDownloading;
	if (this.pendingCustomReads > 0) {
	    this.selectionStatus.textContent = `Reading ${this.pendingCustomReads} custom ZIP${this.pendingCustomReads === 1 ? "" : "s"}...`;
	} else if (this.selectionStatus.textContent.startsWith("Reading ") || this.customReadError) {
	    this.selectionStatus.textContent = this.customReadError;
	}
    }

    handleSelectionChange(event) {
	const steamodded = this.checkboxes.steamodded;
	const mobilepatches = this.checkboxes.mobilepatches;
	const dependentMods = bundledMods.filter(mod => mod.requiresSteamodded);
	let message = "";
	if (event.target === steamodded && !steamodded.checked) {
	    const removed = dependentMods.filter(mod => this.checkboxes[mod.id].checked);
	    for (const mod of removed) this.checkboxes[mod.id].checked = false;
	    if (removed.length) message = `Deselected ${removed.map(mod => mod.name).join(", ")}: they require Steamodded.`;
	} else if (event.target === mobilepatches && mobilepatches.checked && steamodded.checked) {
	    mobilepatches.checked = false;
	    message = "MobilePatches conflicts with this Steamodded version. Deselect Steamodded first.";
	} else if (dependentMods.some(mod => event.target === this.checkboxes[mod.id] && event.target.checked)) {
	    if (!steamodded.checked) {
		steamodded.checked = true;
		message = "Selected Steamodded because this mod requires it.";
	    }
	    if (mobilepatches.checked) {
		mobilepatches.checked = false;
		message += `${message ? " " : ""}Deselected conflicting MobilePatches.`;
	    }
	}
	this.selectionStatus.textContent = message;
    }

    handleCustomMods(event) {
	const files = Array.from(event.target.files);
	const generation = this.readGeneration;
	this.customReadError = "";
	for (const file of files) {
	    if (!/\.zip$/i.test(file.name)) {
		this.customReadError = `Skipped ${file.name}: expected a ZIP file.`;
		continue;
	    }
	    this.pendingCustomReads++;
	    this.updateContinueState();
	    file.arrayBuffer().then(buffer => {
		if (generation !== this.readGeneration) return;
		const data = new Uint8Array(buffer);
		const testZip = zip_open(data);
		testZip.free();
		const name = file.name.substring(0, file.name.lastIndexOf("."));
		this.customMods.push({ name, data });
		this.renderCustomModsList();
	    }).catch(error => {
		if (generation !== this.readGeneration) return;
		console.error("Failed to load custom mod ZIP", error);
		this.customReadError = `Failed to load ${file.name}: invalid or unreadable ZIP.`;
	    }).finally(() => {
		if (generation !== this.readGeneration) return;
		this.pendingCustomReads--;
		this.updateContinueState();
	    });
	}
	event.target.value = "";
	this.updateContinueState();
    }

    renderCustomModsList() {
	this.customList.innerHTML = "";
	this.customMods.forEach((mod, idx) => {
	    const li = document.createElement("li");
	    const label = document.createElement("span");
	    label.textContent = `${mod.name}.zip`;
	    li.appendChild(label);
	    const removeBtn = document.createElement("button");
	    removeBtn.classList.add("remove-btn");
	    removeBtn.innerText = "×";
	    removeBtn.addEventListener("click", () => {
		this.customMods.splice(idx, 1);
		this.renderCustomModsList();
	    });
	    li.appendChild(removeBtn);
	    this.customList.appendChild(li);
	});
    }

    async handleContinue() {
	if (this.pendingCustomReads > 0 || this.isDownloading) return;
	const steamodded = this.checkboxes.steamodded.checked;
	const missingDependency = bundledMods.find(mod => mod.requiresSteamodded && this.checkboxes[mod.id].checked && !steamodded);
	if (missingDependency) {
	    this.selectionStatus.textContent = `${missingDependency.name} requires Steamodded.`;
	    return;
	}
	if (steamodded && this.checkboxes.mobilepatches.checked) {
	    this.selectionStatus.textContent = "MobilePatches conflicts with this Steamodded version.";
	    return;
	}
	this.updateStatus("Downloading selected mods...");
	this.isDownloading = true;
	this.updateContinueState();

	const selectedMods = [];

	for (const mod of bundledMods) {
	    const checkbox = this.checkboxes[mod.id];
	    if (checkbox && checkbox.checked) {
		this.updateStatus(`Downloading ${mod.name}...`);
		try {
		    const response = await fetch(`mods/${mod.filename}`);
		    if (!response.ok) throw new Error(`Bundled download failed: ${response.status}`);
		    const data = new Uint8Array(await response.arrayBuffer());
		    selectedMods.push({ name: mod.name, data, archiveRoot: mod.archiveRoot });
		} catch (e) {
		    console.error(`Error downloading mod ${mod.name}`, e);
		    this.updateStatus(`Failed to download ${mod.name}: ${e.message}`);
		    this.isDownloading = false;
		    this.updateContinueState();
		    return;
		}
	    }
	}

	selectedMods.push(...this.customMods);

	sharedState.mods = selectedMods;
	this.updateStatus("Done!");
	this.isDownloading = false;
	this.updateContinueState();
	this.done();
    }
}

class GenerateStep extends Step {
    constructor(e, i) {
	super(e, i);
	this.status2 = document.createElement("p");
	this.status2.classList.add("status");
	this.element.append(this.status2);
    }

    async ready() {
	super.ready();
	try {
	    // Re-open game.zip from game.data to ensure a fresh, valid ZipFile instance
	    const game = sharedState.gameData;
	    if (game.zip) {
		try { game.zip.free(); } catch { /* The previous WASM value was consumed. */ }
	    }
	    game.zip = zip_open(game.data);

	    await this.patchManifest();
	    await this.patchIcon();
	    await this.copyAssets();
	    await this.signAndSave();
	    this.done();
	} catch(e) {
	    console.error(e);
	    this.updateStatus("An error ocurred: " + e);
	    this.updateStatus2("");
	}
    }

    clear() {
	super.clear();
	this.status2.innerText = "";
    }

    updateStatus2(content) {
	this.status2.innerText = content;
    }

    async patchManifest() {
	this.updateStatus("Patching Manifest...");
	await asyncTimeout();
	if (sharedState.platform === "ios") {
	    await asyncTimeout(100); // iOS doesn't update as much and as such can appear stuck on the metadata step
	    const path = getMainDir(sharedState.apk, sharedState.platform) + "Info.plist";
	    let data = zip_read_file(sharedState.apk, path);
	    let xmlString = decoder.decode(data);
	    const p = new DOMParser();
	    const xml = p.parseFromString(xmlString, "application/xml");
	    const modifed = modifyInfoPlist(xml, sharedState.meta.name, sharedState.meta.bundle);
	    if (!modifed) return;
	    const s = new XMLSerializer();
	    xmlString = s.serializeToString(xml);
	    data = encoder.encode(xmlString);
	    write_file(sharedState.apk, path, data);
	} else {
	    let data = zip_read_file(sharedState.apk, "AndroidManifest.xml");
	    let xmlString = axml_to_xml(data);
	    const p = new DOMParser();
	    const xml = p.parseFromString(xmlString, "application/xml");
	    const modifed = modifyManifest(xml, sharedState.meta.name, sharedState.meta.bundle);
	    if (!modifed) return;
	    const s = new XMLSerializer();
	    xmlString = s.serializeToString(xml);
	    data = xml_to_axml(xmlString);
	    write_file(sharedState.apk, "AndroidManifest.xml", data);
	}
    }

    async patchIcon(){
	if (!sharedState.iconImg) return
	this.updateStatus("Patching icons...");
	await asyncTimeout();
	const img = sharedState.iconImg;
	const qualities = getQualities();
	qualities.all.forEach(([type, size]) => write_file(sharedState.apk, qualities.getPath(type), imgToPNGOfSize(img, size)));
    }

    async injectModsAndPatchMain() {
	const game = sharedState.gameData;
	const mods = sharedState.mods || [];

	this.updateStatus("Integrating mods...");
	await asyncTimeout();

	// 1. Patch main.lua in game.zip
	this.updateStatus2("Patching main.lua...");
	await asyncTimeout();

	let mainLuaData;
	try {
	    mainLuaData = zip_read_file(game.zip, "main.lua");
	} catch(e) {
	    throw new Error("Failed to find main.lua in game files!");
	}

	let mainLuaString = decoder.decode(mainLuaData);
	const luaCopyScript = `
-- Injected by Lovely Mobile Maker to copy bundled mods to the save directory
local function LMM_copy_bundled_mods()
    local log = {}
    local function write_log()
        love.filesystem.write("copy_log.txt", table.concat(log, "\\n"))
    end
    table.insert(log, "Starting LMM Copy script...")

    local mods_dest_dir = "Mods"
    local version_file = "lmm_bundled_mods/version.txt"

    local version_info = love.filesystem.getInfo(version_file)
    if not version_info then
        table.insert(log, "Error: bundled mod metadata not found!")
        write_log()
        return
    end

    local bundled_version = love.filesystem.read(version_file)
    if not bundled_version then
        table.insert(log, "Failed to read bundled version.")
        write_log()
        return
    end
    table.insert(log, "Bundled version: " .. tostring(bundled_version))

    local copied_version_file = mods_dest_dir .. "/.copied_version"
    local copied_version = love.filesystem.read(copied_version_file)
    table.insert(log, "Copied version: " .. tostring(copied_version))

    if copied_version == bundled_version then
        local mods_exist = love.filesystem.getInfo(mods_dest_dir, "directory")
        if mods_exist then
            table.insert(log, "Versions match and Mods directory exists. Skipping copy.")
            write_log()
            return
        end
    end

    local function fail(message)
        table.insert(log, message)
        write_log()
    end

    local function valid_path(path)
        if path:find("\\\\", 1, true) or path:find("%c") or path:sub(1, 1) == "/" or path:find("//", 1, true) then return false end
        local segments = 0
        for part in path:gmatch("[^/]+") do
            if part == "." or part == ".." then return false end
            segments = segments + 1
        end
        return segments >= 2 and path:sub(-1) ~= "/"
    end

    local function parse_files(contents)
        local files, set = {}, {}
        for path in (contents or ""):gmatch("[^\\r\\n]+") do
            if not valid_path(path) then return nil end
            if not set[path] then
                table.insert(files, path)
                set[path] = true
            end
        end
        return files, set
    end

    local bundled_files = love.filesystem.read("lmm_bundled_mods/files.txt")
    if not bundled_files then
        fail("Missing bundled file list.")
        return
    end
    local files, desired = parse_files(bundled_files)
    if not files then
        fail("Invalid bundled file list.")
        return
    end
    local copied_files_path = mods_dest_dir .. "/.lmm_bundled_files"
    local previous_files = love.filesystem.read(copied_files_path)
    local old_files = parse_files(previous_files)
    if not old_files then
        fail("Invalid previous bundled file list.")
        return
    end
    -- Older builds tracked whole mod names only. Leave their files alone rather
    -- than risking deletion of mod-generated settings on the first upgrade.
    if not love.filesystem.createDirectory(mods_dest_dir) then
        fail("Failed to create Mods directory.")
        return
    end

    for _, path in ipairs(files) do
        local source = "lmm_bundled_mods/" .. path
        local target = mods_dest_dir .. "/" .. path
        local parent = target:match("^(.*)/[^/]+$")
        if not love.filesystem.createDirectory(parent) then
            fail("Failed to create directory: " .. parent)
            return
        end
        local data = love.filesystem.read(source)
        if not data then
            fail("Failed to read file: " .. source)
            return
        end
        if not love.filesystem.write(target, data) then
            fail("Failed to write file: " .. target)
            return
        end
    end

    for _, path in ipairs(old_files) do
        if not desired[path] and love.filesystem.getInfo(mods_dest_dir .. "/" .. path) then
            if not love.filesystem.remove(mods_dest_dir .. "/" .. path) then
                fail("Failed to remove obsolete bundled file: " .. path)
                return
            end
        end
    end

    local bundled_manifest = love.filesystem.read("lmm_bundled_mods/manifest.txt")
    if not bundled_manifest or not love.filesystem.write(copied_files_path, bundled_files)
        or not love.filesystem.write(mods_dest_dir .. "/.lmm_bundled_mods", bundled_manifest) then
        fail("Failed to write bundled file metadata.")
        return
    end
    if not love.filesystem.write(copied_version_file, bundled_version) then
        fail("Failed to write completion marker.")
        return
    end
    table.insert(log, "Copy complete.")
    write_log()
end

local ok, err = pcall(LMM_copy_bundled_mods)
if not ok then
    love.filesystem.write("copy_log.txt", "LMM script crashed: " .. tostring(err))
end
`;
	mainLuaString = luaCopyScript + mainLuaString;
	mainLuaData = encoder.encode(mainLuaString);
	write_file(game.zip, "main.lua", mainLuaData);

	// 2. Add each mod's contents under a private source directory in game.zip.
	const modsVersion = Date.now().toString();
	write_file(game.zip, "lmm_bundled_mods/version.txt", encoder.encode(modsVersion));
	const managedModNames = [];
	const managedFiles = [];

	for (const mod of mods) {
	    const modName = safeModName(mod.name);
	    if (!modName) {
		console.error("Skipping mod with an invalid name", mod.name);
		continue;
	    }
	    this.updateStatus2(`Extracting mod ${modName}...`);
	    await asyncTimeout();

	    let modZip;
	    try {
		modZip = zip_open(mod.data);
	    } catch(e) {
		console.error("Failed to open mod zip: " + mod.name, e);
		continue;
	    }

	    const modFiles = entry_names(modZip)
		.filter(source => !source.endsWith("/") && !source.endsWith("\\"))
		.map(source => ({ source, path: normalizeZipEntryPath(source) }))
		.filter(file => file.path);
	    let prefix = mod.archiveRoot || "";
	    if (modFiles.length > 0) {
		const configuredFiles = prefix ? modFiles.filter(file => file.path.startsWith(prefix)) : modFiles;
		if (configuredFiles.length === 0) {
		    console.error(`Configured archive root not found for ${modName}: ${prefix}`);
		    modZip.free();
		    continue;
		}
		const first = configuredFiles[0].path;
		const slashIdx = first.indexOf("/");
		if (!prefix && slashIdx !== -1) {
		    const testPrefix = first.substring(0, slashIdx + 1);
		    let allMatch = true;
		    for (const f of configuredFiles) {
			if (!f.path.startsWith(testPrefix)) {
			    allMatch = false;
			    break;
			}
		    }
		    if (allMatch) {
			prefix = testPrefix;
		    }
		}
	    }

	    for (const file of modFiles) {
		if (prefix && !file.path.startsWith(prefix)) continue;
		const fileData = zip_read_file(modZip, file.source);

		let relativePath = file.path;
		if (prefix && file.path.startsWith(prefix)) {
		    relativePath = file.path.substring(prefix.length);
		}
		if (!relativePath) continue;

		const destPath = `lmm_bundled_mods/${modName}/${relativePath}`;
		write_file(game.zip, destPath, fileData);
		managedFiles.push(`${modName}/${relativePath}`);
	    }
	    managedModNames.push(modName);
	    modZip.free(); // Free WASM memory for this mod zip!
	}
	write_file(game.zip, "lmm_bundled_mods/manifest.txt", encoder.encode(managedModNames.join("\n")));
	write_file(game.zip, "lmm_bundled_mods/files.txt", encoder.encode(managedFiles.join("\n")));

	this.updateStatus2("Mods integration complete!");
	await asyncTimeout();
    }

    async copyAssets(){
	this.updateStatus("Copying game files...");
	console.time("Copying files");
	const game = sharedState.gameData;

	await this.injectModsAndPatchMain();

	if (sharedState.platform === "ios") {
	    const gameLoveData = zip_save(game.zip);
	    game.zip = null; // zip_save consumes the WASM ZipFile.
	    write_file(sharedState.apk, getMainDir(sharedState.apk, sharedState.platform) + "game.love", gameLoveData);
	} else {
	    const files = entry_names(game.zip);
	    let count = 0;
	    for (const f of files) {
		if (f.endsWith("/")) continue;
		count++;
		if (count % 20 === 0) {
		    this.updateStatus2(`Copying file ${count}...`);
		    await asyncTimeout();
		}
		const d = zip_read_file(game.zip, f);
		const nn = "assets/" + f;
		write_file(sharedState.apk, nn, d);
	    }
	    game.zip.free(); // Free WASM memory for game.zip on Android!
	    game.zip = null;
	}
	console.timeEnd("Copying files");
	this.updateStatus2("");
    }

    async signAndSave(){
	this.updateStatus("Signing game...");
	await asyncTimeout();
	const raw = zip_save_and_sign_v2(sharedState.apk, sharedState.cert);
	sharedState.apk = null; // zip_save_and_sign_v2 consumes the WASM ZipFile.

	this.updateStatus("Done");
	sharedState.final = raw;
	downloadBlob(raw, "game" + sharedState.platformValues.ext, sharedState.platformValues.mime);
    }

    reset() {
	super.reset();
	this.final = null;
    }
}

class DoneStep extends Step {
    constructor(e, i) {
	super(e, i);
	const button = document.getElementById("done-download");
	button.addEventListener("click", () => downloadBlob(sharedState.final, "game" + sharedState.platformValues.ext, sharedState.platformValues.mime));
    }

    ready() {
	super.ready();
    }
}

const steps = [
    GameStep,
    PlatformStep,
    DownloadStep,
    MetaStep,
    ModStep,
    GenerateStep,
    DoneStep,
];


function loadSteps() {
    steps.forEach((step, i) => {
	const ele = document.getElementById(`step${i + 1}`);
	if (!ele) throw "Hi dad";
	liveSteps.push(new step(ele, i));
    });
}

export {
    loadSteps,
}
