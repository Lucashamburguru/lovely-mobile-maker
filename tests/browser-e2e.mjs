const cdpPort = process.env.CDP_PORT || "9223";
const gameFile = process.env.LMM_TEST_GAME;

if (!gameFile) throw new Error("LMM_TEST_GAME is required");

const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then(response => response.json());
const target = targets.find(candidate => candidate.type === "page");
if (!target) throw new Error("No Chromium page target found");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const browserErrors = [];
let downloadCompleted;
const downloadPromise = new Promise(resolve => { downloadCompleted = resolve; });

socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
    }
    if (message.method === "Runtime.exceptionThrown") {
        browserErrors.push(message.params.exceptionDetails.text);
    }
    if (message.method === "Browser.downloadProgress" && message.params.state === "completed") {
        downloadCompleted(message.params);
    }
});

function send(method, params = {}) {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
}

async function waitFor(expression, description, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${description}`);
}

await send("Runtime.enable");
await send("Page.enable");
await send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: process.env.LMM_TEST_DOWNLOADS,
    eventsEnabled: true,
});
await send("Page.navigate", { url: process.env.LMM_TEST_URL });
await waitFor("document.readyState === 'complete'", "page load");

const documentNode = await send("DOM.getDocument");
const inputNode = await send("DOM.querySelector", {
    nodeId: documentNode.root.nodeId,
    selector: "#gamefile",
});
await send("DOM.setFileInputFiles", { nodeId: inputNode.nodeId, files: [gameFile] });

await waitFor("!document.querySelector('#step2').classList.contains('collapsed')", "game validation");
await evaluate(`(() => {
    const select = document.querySelector('#step2 select');
    select.value = 'android';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
})()`);

await waitFor("!document.querySelector('#step4').classList.contains('collapsed')", "base APK preparation");
await waitFor(`(() => {
    const images = [...document.querySelectorAll('.meta-icon-list img')];
    return images.length === 3 && images.every(image => image.complete && image.naturalWidth > 0);
})()`, "preset icon images");
await evaluate("document.querySelector('#meta-ready').click(); true");
await waitFor("!document.querySelector('#step5').classList.contains('collapsed')", "metadata submission");

await evaluate(`(() => {
    for (const checkbox of document.querySelectorAll('#step5 input[type=checkbox]')) checkbox.checked = true;
    document.querySelector('#mods-ready').click();
    return true;
})()`);

await waitFor("!document.querySelector('#step6').classList.contains('collapsed')", "mod selection");
await Promise.race([
    downloadPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for APK download")), 180_000)),
]);
await waitFor("!document.querySelector('#step7').classList.contains('collapsed')", "completed build");

socket.close();
if (browserErrors.length) throw new Error(`Browser exceptions: ${browserErrors.join('; ')}`);
