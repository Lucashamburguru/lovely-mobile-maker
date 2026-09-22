# Lovely Mobile Maker

Tool to make an apk with lovely from a love game *cough cough* balatro.

# Development
Below are the instructions to make a working build.

## MBF zip

This uses a modified version of [ModsBeforeFriday](https://github.com/Lauriethefish/ModsBeforeFriday)'s [mbf-zip](https://github.com/Lauriethefish/ModsBeforeFriday/tree/main/mbf-zip) and [mbf-axml](https://github.com/Lauriethefish/ModsBeforeFriday/tree/main/mbf-axml) with support for WASM.

To build it you musr first install [wasm-pack](https://drager.github.io/wasm-pack/installer/). After that, you can run:

```sh
cd bindgen
RUSTFLAGS='--cfg getrandom_backend="wasm_js"' wasm-pack build --target web
```

This generates a folder pkg with the required files. There is a symlimk so this folder should be used automatically

## Base Apps
The base apk for android devices (base.apk) is built from [lmm-love-android](https://github.com/WilsontheWolf/lmm-love-android),
and the base ipa for iOS devices (base.ipa) is from [lmm-love](https://github.com/WilsontheWolf/lmm-love) (using [lmm-love-apple-dependencies](https://github.com/WilsontheWolf/lmm-love-apple-dependencies)).

If your goal is just to make changes to the website, you can just download the base apps from the production lmm ([base.apk](https://lmm.shorty.systems/base.apk) [base.ipa](https://lmm.shorty.systems/base.ipa)).

## Bundled mods

The web app can bundle Steamodded and optional mods into the generated APK or IPA. It also accepts custom mod ZIPs. Bundled mods are installed into the game's save directory on launch, and a managed manifest removes stale files when the selected bundle changes without deleting unrelated user-installed mods.

The archives served by the site live in `mods/`. Keep the version labels in `index.html` in sync when replacing them. MobilePatches intentionally defaults off because it conflicts with current Steamodded releases.

## Verification

Run the Rust tests and the real browser build test with:

```sh
cargo test --workspace
scripts/test-browser-e2e.sh
```

The browser test uploads a synthetic LÖVE game, builds an Android APK in headless Chromium, and verifies the injected mod installer and bundled Steamodded files.

## Exporting to webadmin

To rebuild the WASM package, copy a production snapshot into the webadmin Cloudflare project, and rebuild its static assets:

```sh
scripts/export-webadmin.sh /home/pengo/Dev/webadmin
```

`wasm-pack` generates `bindgen/pkg/.gitignore` with a wildcard. The export script deliberately excludes that file so the generated JavaScript bindings and WASM binary remain tracked in webadmin.
