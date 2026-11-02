# Cyber Mod Manager

A Nexus Mods downloader and mod manager for Cyberpunk 2077, for Windows.

### [⬇ Download the latest version](https://github.com/skyehosting/cyber77-mod-manager/releases/latest/download/Cyber-Mod-Manager-Setup.exe)

[![Latest release](https://img.shields.io/github/v/release/skyehosting/cyber77-mod-manager?label=latest&style=flat-square)](https://github.com/skyehosting/cyber77-mod-manager/releases/latest) · [All releases](https://github.com/skyehosting/cyber77-mod-manager/releases)

## Install

Download [`Cyber-Mod-Manager-Setup.exe`](https://github.com/skyehosting/cyber77-mod-manager/releases/latest/download/Cyber-Mod-Manager-Setup.exe) (always the newest version; also on the [releases page](https://github.com/skyehosting/cyber77-mod-manager/releases/latest)) and run it. It installs for your Windows user only (no admin rights) and starts the app. The installer is not code-signed, so Windows SmartScreen may warn the first time: choose **More info** → **Run anyway**.

The app keeps itself up to date: while it is open it checks for a new version every 2 minutes (Settings → Folders & tools → App updates: any number of minutes, hours or days), downloads it, and restarts to install it once nothing is downloading or installing. **Later** on the notice leaves the update for when you close the app. Your settings (API key included), Nexus login, mods and downloads are kept: they live in `%APPDATA%Cyber Mod Manager`, which updates never touch. Settings and the mod library also keep a backup of their last good version, used if the file is ever damaged or missing.

7-Zip ships with the app (used when 7-Zip is not installed). You need a Nexus Mods account and its personal API key. Premium and free accounts both work (see **Free accounts** below).

## Start

1. **Settings** → paste your Nexus API key → **Validate** → **Save**. The game folder is found automatically (Steam, GOG, Epic Games, the Xbox app); every install found is listed there to pick from.
2. **Browse** → search Nexus by name or mod ID → **Download** on a mod (or open it to read its pages first). Or, in **Downloads**, paste one or more mod links (any form: with or without `?tab=…`, `/games/…`, or a `file_id`) → **Choose files** → tick the files you want → **Download**.
3. **Play** (top of the sidebar) starts the game through its store (Steam, Epic) or directly (GOG, Xbox, other), with `-modded` when REDmods are installed.
4. **Mods** → select (click, Ctrl-click, Shift-click, Ctrl+A) → Enable / Disable / Prioritize / Reinstall / Uninstall / Delete.

## What it does

- **Browse Nexus.** Search Cyberpunk 2077's mods on Nexus without leaving the app. Results update as you type: names match word by word as typed (`archivex` finds ArchiveXL), and a number is also looked up as a mod ID, shown first. Filter by category (with each one's mod count), sort by most endorsed, most downloaded, recently updated, newest, best match or name, and show 20 to 80 mods per page. Adult mods are included; the **Adult (18+)** entry at the top of the category list shows only those. Mods you already have, here or in Vortex, are marked **Installed**. **Download** on a card opens the file picker below.
  - Clicking a mod opens its Nexus page inside the app (with the site's own Description, Files, Posts and Bugs tabs). **Open in browser** opens the page you are on in your web browser. The pages run in their own sandboxed browser session that only shows nexusmods.com (other links open in your web browser), and they remember a Nexus login and the site's cookie choice. A "Manual download" or "Mod Manager Download" clicked there is downloaded by this app.
  - Ads and trackers on these pages are blocked (Settings → Downloading), with Ghostery's blocker and the usual filter lists (EasyList, EasyPrivacy, uBlock Origin's), the same kind Brave uses. The lists are downloaded once and refreshed weekly.
  - Logging in to the Nexus website is separate from the API key: the site has no way to sign in with an API key, and your browser's own login cannot be borrowed (browsers encrypt it for themselves). **Log in to Nexus** on the Browse page opens the sign-in page once; it is remembered. Sign in with email and password there: Google, Discord and other sign-in buttons go to sites outside Nexus, which open in your browser instead. The app's own **Download** buttons only need the API key.
- **Choose files.** Before downloading, a dialog lists every file on the mod's Files tab grouped by category (Main, Updates, Optional, Misc, Old versions, Archived), each with its description, version, size and upload date. Files in the categories chosen in Settings start ticked (Main, Update, Optional, Misc by default). **Select all**, **Select none**, **Suggested** and a tick per category change that. Files already downloaded are marked.
- **Free accounts.** Nexus gives free accounts no direct download links: each file needs one click on "Slow download" on its Nexus page, which hands over a one-time key. The app does everything around that click: files that need it wait in Downloads (**Needs a click**), and the Browse page opens each one's download page in turn. Click **Slow download** (sign in to Nexus there first, once); the download continues in the app and the next file's page opens by itself. This covers everything that downloads: picked files, requirements, updates and imported profiles. The app never clicks for you: Nexus does not allow automating it, and accounts that do it get banned. With Premium none of this appears.
- **Downloads** the ticked files directly through the API (with Premium; see above for free accounts), the same file the site's "Manual download" button gives you. The Downloads page shows each download's progress, speed and time left, and a live **Network** graph (current speed, peak, total this session).
- **Nexus "Mod Manager Download" buttons** (`nxm://` links) can be handled here: turn on the switch in Settings (it applies at once and asks first). Clicking one on nexusmods.com then downloads that file in this app; the first time, your browser asks whether to open Cyber Mod Manager. This works without Premium, because the link carries its own key. Whatever handled these links before is saved first (`nxm-previous-handler.reg`), and turning the switch off puts it back. Settings shows which program has the links now. Vortex takes them back each time it starts, unless you turn off "Handle Nexus links" in Vortex's settings.
- Downloaded files are organised as `downloads/<game>/<Mod name> (<id>)/<Category>/<file>`. Already-downloaded files are skipped. Downloads run in parallel (4 by default), retry 3 times, and can be cancelled.
- **Installs** by extracting with 7-Zip and placing each file where Cyberpunk expects it:
  - `.archive` / `.xl` → `archive/pc/mod`
  - a folder with `init.lua` → `bin/x64/plugins/cyber_engine_tweaks/mods/<name>`
  - `.reds` → `r6/scripts/<name>`
  - `.yaml` (TweakXL) → `r6/tweaks/<name>`
  - `.dll` → `red4ext/plugins/<name>`
  - `.asi` → `bin/x64/plugins`
  - `info.json` with REDmod folders → `mods/<name>`
  - `.xml` → `r6/input`
  - `.ini` → `engine/config/platform/pc`

  Archives that are already laid out from the game root (`archive/`, `bin/`, `r6/`, `red4ext/`, `engine/`, `mods/`) keep that layout, even inside wrapper folders. **FOMOD** installers get a step-by-step wizard. Readmes and images are not installed. Unknown files are reported in the console.
- **Drag and drop** `.zip`, `.7z` or `.rar` archives onto the window to install them. Archives downloaded by hand from Nexus keep their mod ID and version (from the file name), so updates and version grouping work for them too.
- The Mods list is in **A to Z** order (numbers in number order).
- **Versions** of one mod share one row, as in Vortex (for example ArchiveXL 1.28.3 and 1.28.6). The Version column becomes a menu: picking another version switches to it in one step.
- **Enables** mods the way Vortex does: files are kept in a staging folder and hardlinked into the game (or copied, if you choose that). When two enabled mods ship the same file, the one with the higher priority wins. **Prioritize** moves the selected mods to the top. If a mod would overwrite a file that is already in the game folder, that file is first moved to `data/backups` and is restored when the mod is disabled. The app only ever deletes files it placed itself.
- **Requirements checklist.** Before anything downloads, every requirement (and the requirements of those) is listed with a status:
  - not installed;
  - downloaded, so it will be installed;
  - disabled, so it will be enabled;
  - installed;
  - in the game folder, installed by another tool;
  - not on Nexus, with a link to its page.

  They are shown as a tree: each requirement under the mod that needs it, its own requirements under it, as deep as they go. A requirement two mods need, or one that leads back to a mod above it (a loop), is shown once and referred to after that. Missing ones start ticked; ticking a requirement ticks what it needs, and unticking it unticks what nothing else ticked still needs. **All** / **None** set everything at once.
- **Updates.** **Check for updates** asks Nexus for each installed mod's files and follows each file's update chain to the newest version. If an author didn't link the new file, it falls back to the newest current file with the same name. Mods with an update get an **Update → version** tag and appear under the **Updates** filter; you can update them all or a selection. An update downloads the new file and installs it in the old version's place, keeping its on/off state, priority and profiles. Files that only the old version had are removed.
- **Profiles.** A profile is a named set of enabled mods with its own conflict order. The **Profiles** page shows each one as a card. From there you can activate a profile, create one (empty, or copied from what is enabled now), rename, export or delete it. The active profile follows every enable and disable you make. Vortex's profiles are listed below yours, read-only.
- **Sharing profiles.** Each profile card has **Copy code**: a share code (`CMM1-…`, a few hundred characters for a big profile) that holds the profile's **enabled, installed** mods with their exact Nexus file IDs, in priority order, and the options picked in FOMOD installers. The code is made from the profile itself, so it changes whenever you enable, disable, reorder or update a mod; the card shows a short tag of the current code. Nothing is uploaded anywhere: the code is the data. Mods installed from local files can't be in a code (they aren't on Nexus); the receiver is told how many there were. The export button (share icon) saves the same profile as a `.cmmprofile.json` file instead. Send either to anyone. They choose **Import**, paste the code (or choose the file) and see a review of every mod:
  - **will enable**: they already have that exact file;
  - **will install**: it is downloaded but not installed;
  - **will download**: the exact file is fetched from Nexus;
  - **newer version**: the author removed that file, so its replacement is used;
  - **not available**: a local archive of yours, or a file that is gone from Nexus.

  Importing creates the profile, switches to it and downloads what is missing. Each mod installs into that profile as it finishes, and is put into the sender's priority order, so file conflicts resolve the same way. Mods with a FOMOD installer still ask for their options.
- **Changes made outside the app.** Every 15 seconds the game folder is checked:
  - A mod whose files were all deleted by hand is shown as disabled, and any original game files it had replaced are restored.
  - A mod with only some files missing, or files replaced by another tool, gets a "N missing" tag and a **Repair** button.
- **Requirements** are resolved automatically. A mod's Nexus requirements come from the Nexus v2 (GraphQL) API. Each missing requirement's main file is downloaded, installed and enabled, and the requirements of those requirements are handled the same way, with cycles stopped. A requirement is skipped if it is already installed here, or already in the game folder from Vortex or a manual install. That check uses the framework's own files (`red4ext/RED4ext.dll`, `cyber_engine_tweaks.asi`, `engine/tools/scc.exe`, …) or a mod folder with a matching name. A requirement that is installed here but disabled is enabled instead. Requirements hosted off Nexus (GitHub and so on) are listed in the console with their link. You can turn this off in Settings.
- **Game log** follows every log the game and its mods write, and merges them live into one timeline:
  - CET and each CET mod, RED4ext and each RED4ext plugin, redscript, ArchiveXL, TweakXL, Codeware, Input Loader, Mod Settings, ReShade, and any other `.log` under `bin/x64`, `red4ext`, `r6/logs`, `engine`, `tools` or `mods`.
  - Rotated session logs are grouped, and only the current one is followed.
  - **Problems** groups repeated errors and warnings, with a count for each.
  - **Sources** lists every log file, with buttons to open it or show it in its folder.
  - It detects when the game starts and stops, and notices new crash reports from the game's crash reporter.
  - Errors from a mod's own folder are counted on that mod in the Mods list (filter: **Problems**) and shown in its details panel.
- The **Console** at the bottom shows the app's own info, warning and error messages, and opens by itself when an error happens. It can be resized. Logs are also written to `%APPDATA%\Cyber Mod Manager\logs`.
- **Manager** (a Game log tab) is this app's own record, newest first: what was enabled or disabled (by name and version), installed, updated, switched. It is kept across restarts (`logs\manager-history.jsonl`, the last 3,000 lines) and is not part of exported reports.
- **Export report.** The Game log and the Console both export the same single `.json` report: every error and warning from the game's and mods' logs, grouped with how often and when each happened and also listed in full, which mod each one comes from, and every mod (this app's and Vortex's) with its version, on/off state, type, conflicts, repairs needed and available updates.

## Display

The window opens at a size based on your screen and remembers where you left it. All sizes are in `rem`, and the root size scales with the window's width and height, so the layout fits any resolution, aspect ratio (16:9, 16:10, 21:9, 32:9, 5:4) and Windows scale factor. Fixed-shape elements (icons, switches, dots, buttons, images, dialogs) keep their aspect ratio. Narrow windows switch the sidebar to an icon rail and hide less important columns. **Ctrl +**, **Ctrl −** and **Ctrl 0** zoom the whole UI. `node tools/capture.js <dir>` screenshots every screen at 13 display setups for design review.

## Living alongside Vortex

When Vortex is installed, its Cyberpunk 2077 mods appear in the Mods list with a **Vortex** tag (filter: **Vortex**). Their on/off state is read live from Vortex's deployment record (`<game>\vortex.deployment.json`), and their Nexus IDs, versions and profiles from Vortex's own state snapshots.

- **Enable / disable** a Vortex mod here without opening Vortex. The new state is recorded with Vortex's own command line (`Vortex.exe --set …`, which changes Vortex's data and quits without a window), and the mod's files are hardlinked into or removed from the game folder here, the same way Vortex's hardlink deployment does it, with `vortex.deployment.json` updated to match (the version Vortex last wrote is kept once as `vortex.deployment.json.cmm-backup`). Vortex then finds everything as it expects.
  - Vortex locks its data while it is open. If it is open, it is closed for a moment and reopened after the change (you are asked once first).
  - Files that two Vortex mods both ship, or that are already in the game folder from somewhere else, follow Vortex's own rules: they are left for Vortex, which sorts them out the next time it starts.
  - Each Vortex mod's Type is worked out from its files, and the **Vortex** tag sits in the Type column.
- **Check for updates** includes Vortex mods. **Update** hands the new file to Vortex, which installs it and asks how to replace the old version.
- Reinstall, uninstall and delete for Vortex mods stay in Vortex.
- A mod of this app that writes the same file as a Vortex mod gets a **Vortex N** tag in the Conflicts column. Whichever tool deploys last wins that file, so don't enable the same mod in both. If this app has to overwrite a file that Vortex deployed, it backs that file up first.

## Data

`%APPDATA%\Cyber Mod Manager\`: `settings.json` (the API key is encrypted with Windows DPAPI), and `data\` (downloads, staging, backups, `library.json`, `deployment.json`).

## Releases

Every push to `main` publishes a new version (`.github/workflows/release.yml`, on GitHub's Windows runners): the tests run, the app is built with electron-builder, and a GitHub release `v1.1.<build number>` is published with the installer and `latest.yml`, which installed copies check. A push never ships a key: `tools/check-secrets.js` scans every tracked file, and then everything inside the built app, for API keys and tokens, and stops the release on any hit. The app's own settings (where your API key is kept, encrypted) live in `%APPDATA%\Cyber Mod Manager` and are never part of the repository or the build.

From source: `npm install`, then `npm start` (or `Start Cyber Mod Manager.cmd`). `npm run dist` builds the installer locally into `dist/`.

## Tests

`npm test`. These cover:
- the layout rules;
- FOMOD parsing and evaluation;
- the deployment engine;
- recursive requirement resolution;
- log parsing and live tailing;
- a full import → install → enable → conflict → uninstall run against a fake game folder;
- the app's update schedule and restart;
- reading Vortex's state and deploying Vortex mods without Vortex, mod link and `nxm://` parsing, the file picker plan, store detection, Nexus mod search, and the diagnostics report.
