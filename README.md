# Cyber Mod Manager

A small Nexus Mods downloader and mod manager for Cyberpunk 2077 (Electron).

## Start

Double-click `Start Cyber Mod Manager.cmd` (or `npm start`). Requires 7-Zip (`C:\Program Files\7-Zip\7z.exe` by default).

1. **Settings** → paste your Nexus API key → **Validate** → **Save**. The game folder is found automatically from Steam.
2. **Downloads** → paste one or more mod links (`https://www.nexusmods.com/cyberpunk2077/mods/<id>`) → **Download all files**.
3. **Mods** → select (click, Ctrl-click, Shift-click, Ctrl+A) → Enable / Disable / Prioritize / Reinstall / Uninstall / Delete.

## What it does

- **Downloads** every file on the mod's Files tab in the categories chosen in Settings (Main, Update, Optional, Misc by default; Old versions/Archived off). It fetches the archive directly through the Premium API, the same file the site's "Manual download" button gives you, not the `nxm://` mod-manager hand-off. Files are organised as `downloads/<game>/<Mod name> (<id>)/<Category>/<file>`. Already-downloaded files are skipped. Downloads run in parallel (4 by default), retry 3 times, and can be cancelled.
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
- **Enables** mods the way Vortex does: files are kept in a staging folder and hardlinked into the game (or copied, if you choose that). When two enabled mods ship the same file, the one with the higher priority wins. **Prioritize** moves the selected mods to the top. If a mod would overwrite a file that is already in the game folder, that file is first moved to `data/backups` and is restored when the mod is disabled. The app only ever deletes files it placed itself.
- The **Console** at the bottom shows every info, warning and error message, and opens by itself when an error happens. Logs are also written to `%APPDATA%\cyber-mod-manager\logs`.

## Living alongside Vortex

Your game is currently also managed by Vortex. Don't enable the same mod in both tools. If this app has to overwrite a file that Vortex deployed, it backs that file up first, and Vortex will then report it as "changed externally". The safest setup is to use one tool for any given mod.

## Data

`%APPDATA%\cyber-mod-manager\`: `settings.json` (the API key is encrypted with Windows DPAPI), and `data\` (downloads, staging, backups, `library.json`, `deployment.json`).

## Tests

`npm test`. These cover the layout rules, FOMOD parsing and evaluation, the deployment engine, and a full import → install → enable → conflict → uninstall run against a fake game folder.
