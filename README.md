# Edgerunners Mod Manager

The all-in-one mod manager for Cyberpunk 2077 on Windows: Nexus downloads, profiles, load order, game logs, crash help and an optional AI helper, in one app. Formerly Cyber Mod Manager.

### [⬇ Download the latest version](https://github.com/skyehosting/edgerunners-mod-manager/releases/latest/download/Edgerunners-Mod-Manager-Setup.exe) · [Project page](https://skyehosting.github.io/edgerunners-mod-manager/)

[![Latest release](https://img.shields.io/github/v/release/skyehosting/edgerunners-mod-manager?label=latest&style=flat-square)](https://github.com/skyehosting/edgerunners-mod-manager/releases/latest) · [All releases](https://github.com/skyehosting/edgerunners-mod-manager/releases)

## Screenshots

The pages in the order of the sidebar, with demo mods. Click one to see it full size. More on the [project page](https://skyehosting.github.io/edgerunners-mod-manager/).

### Mods

Every mod with its status, conflicts, updates and version. Click one for its details panel; right-click for its actions.

[![Mods](docs/assets/shots/mods.webp)](docs/assets/shots/mods.webp)

### Load order

Archives top to bottom: the higher one wins. Drag, type a new position, or Auto-sort by what each mod needs.

[![Load order](docs/assets/shots/loadorder.webp)](docs/assets/shots/loadorder.webp)

### Mod files

Every mod's files, each copy in its own section; edit text files in the built-in editor.

[![Mod files](docs/assets/shots/config.webp)](docs/assets/shots/config.webp)

### Browse Mods

Search, filter and sort Nexus mods, or switch to mod.io (CD PROJEKT RED's official mod site); Download picks the files and installs them.

[![Browse Mods](docs/assets/shots/browse.webp)](docs/assets/shots/browse.webp)

### Downloads

Paste a link, choose its files, and follow each download in the In progress panel.

[![Downloads](docs/assets/shots/downloads.webp)](docs/assets/shots/downloads.webp)

### Game log

Every log the game and its mods write, in one live timeline; every play kept, filed under its profile.

[![Game log](docs/assets/shots/gamelog.webp)](docs/assets/shots/gamelog.webp)

### AI Assistant

Optional: your own AI provider reads your mods and logs, explains errors and proposes fixes you approve.

[![AI Assistant](docs/assets/shots/ai.webp)](docs/assets/shots/ai.webp)

### Profiles

Separate setups, a share code for friends, and a Vortex or Mod Organizer 2 profile used here in one click.

[![Profiles](docs/assets/shots/profiles.webp)](docs/assets/shots/profiles.webp)

### Themes

Seven built-in looks (Settings → Interface), or your own in **Theme Studio**: colours (with a colour picker and readability checks), a background picture of your own (fit, dim, blur), see-through sidebar and panels, frosted glass, and animation drawn behind the app, over the page or over everything: falling cherry blossom petals, snow, rain, embers, bubbles or stars (count, size, speed, wind, colours, or your own picture as the particle), or your own animation code, which runs sealed off (it can only draw: no files, no internet, no access to the app). Save themes by name in `Documents/Edgerunners Mod Manager/Themes` (one `.emmtheme` file each, pictures included, ready to share), load them back, or import one someone sent you.

[![Themes](docs/assets/shots/themes.webp)](docs/assets/shots/themes.webp)

## What's in it

- **Setup wizard.** The first time it opens, a short welcome finds the game, connects your Nexus account and, if you like, an AI helper. Every step can be skipped; Settings → Advanced → **Run it again**.
- **Sidebar.** Grouped pages that fold to an icon rail (the button by the name, or Ctrl+B). **Play** sits on top with a **profile dropdown** under it, to switch profiles in one click.
- **Themes.** Netrunner (the default), Samurai, NCPD, We made it David ~, Corpo, El Coyote Cojo and Cherry Blossom, each checked for readability on every page; or **Custom**: the whole theme as text, with a colour picker, live preview and readability checks. Settings → Interface also lets the app go by Lucy's, David's or Netrunner's Mod Manager.
- **Per-profile game logs.** Each play remembers the profile it ran with; the Game log's play picker filters by profile.
- **Vortex profiles.** Profiles → Vortex profiles → **Use here** sets this app up the way a Vortex profile is.
- **Mod Organizer 2 profiles.** Profiles → Mod Organizer 2 profiles → **Use here** does the same for an MO2 profile, in MO2's order (see below).

## Install

Download [`Edgerunners-Mod-Manager-Setup.exe`](https://github.com/skyehosting/edgerunners-mod-manager/releases/latest/download/Edgerunners-Mod-Manager-Setup.exe) (always the newest version; also on the [releases page](https://github.com/skyehosting/edgerunners-mod-manager/releases/latest)) and run it. It installs for your Windows user only (no admin rights) and starts the app. The installer is not code-signed, so Windows SmartScreen may warn the first time: choose **More info** → **Run anyway**.

The app keeps itself up to date: it checks for a new version each time it opens and once a day while it stays open (Settings → Advanced → App updates: any number of minutes, hours or days), downloads it, and restarts to install it once nothing is downloading or installing. **Later** on the notice leaves the update for when you close the app. Your settings (API key included), Nexus login, mods and downloads are kept: they live in `%APPDATA%\Cyber Mod Manager`, which updates never touch. Settings and the mod library also keep a backup of their last good version, used if the file is ever damaged or missing. New versions show at the top of the window from the moment one is found. Settings → Advanced → **New versions**: *Install automatically* restarts to install when nothing is in progress and the window is in view, after a 30-second notice (**Later** leaves it for when you close the app); *Download, then ask*; or *Off* (no checks by itself; **Check now** still works). While the game runs nothing is checked or restarted.

7-Zip ships with the app (used when 7-Zip is not installed). You need a Nexus Mods account and its personal API key. Premium and free accounts both work (see **Free accounts** below).

## Start

1. **The setup wizard** (it opens the first time; or Settings) → paste your Nexus API key → **Check key**. The game folder is found automatically (Steam, GOG, Epic Games, the Xbox app); every install found is listed there to pick from.
2. **Browse** → search Nexus by name or mod ID → **Download** on a mod (or open it to read its pages first). Or, in **Downloads**, paste one or more mod links (any form: with or without `?tab=…`, `/games/…`, or a `file_id`) → **Choose files** → tick the files you want → **Download**.
3. **Play** (top of the sidebar) starts the game directly (no Steam "custom arguments" prompt, no CD Projekt launcher), with `-modded` when REDmods are installed. When your REDmods changed since the last time, it runs REDmod deploy first (as the launcher and Vortex do); if that fails you see why and can launch anyway. REDmods need CD Projekt's free REDmod tools (`tools\redmod\bin\redMod.exe`): when a copy of the game lacks them, Play explains how to get them for its store (Steam and GOG: a free DLC; Epic: part of the game since 1.6, put back by Verify) and then starts the game without REDmods; it asks once per session. Epic Games copies start through the Epic launcher. Settings → Game → **When you press Play** can start Steam copies through Steam instead, so the Steam overlay works. Steam asks to confirm any arguments another program passes, so none are passed: the game's own Steam launch options (Properties → General) need `--launcher-skip -modded`. The app reads them, and when they are missing Play shows the exact line to paste, with Copy and Open in Steam. The REDmod button on the Mods page shows where they stand (deployed, changed since, or the last deploy failed) and runs a deploy by hand. Only REDmods need deploying: archive, CET, redscript, RED4ext and TweakXL mods work as soon as their files are in place. While the game runs, the button turns into **Stop**: click it twice (the second click confirms) to close the game.
4. **Mods** → select (click, Ctrl-click, Shift-click, Ctrl+A) → Enable / Disable / Prioritize / Reinstall / Uninstall / Delete.

## What it does

- **Browse Mods: mod.io.** The switch beside the page title changes to Cyberpunk 2077's mods on mod.io. It uses your own free mod.io API key and API path (mod.io → your account → API Access; mod.io's terms keep each key to its own account, so the app never ships one), stored encrypted. Search, filter by category and language, sort (trending, recently added, last updated, most popular, most subscribers, highest rated, alphabetical) and limit to a release time. Only mods with a PC file are listed. A mod's page shows its pictures, description, file, changelog and the mods it needs; **Download** gets it and what it needs, checks each file against mod.io's checksum, and installs it like any other mod. Mods marked mature are blurred until shown. Mods from mod.io are checked for updates on mod.io, and mods moved from Vortex or read from MO2 keep their Nexus ids only when they came from Nexus (a Vortex mod a mod.io extension installed keeps its mod.io ids).
- **The game's own Mods menu (mod.io).** Mods Cyberpunk 2077 installed from its in-game Mods menu are shown, read only: a link on the Mods page lists them, Profiles lists them under "Also loaded", a mod installed both there and here is flagged (it can load twice), and so is an archive of the same name. The app reads mod.io's state file (`Public/mod.io/5784/metadata/state.json`, or where mod.io's settings moved it; on Linux inside the game's Proton folder), never the player's mod.io sign-in. The game installs, updates and switches these itself.
- **Browse Mods: Nexus Mods.** Search Cyberpunk 2077's mods on Nexus without leaving the app. Results update as you type: names match word by word as typed (`archivex` finds ArchiveXL), and a number is also looked up as a mod ID, shown first. Filter by category (with each one's mod count), sort by most endorsed, most downloaded, recently updated, newest, best match or name, limit to a time (past 24 hours, week, month or year: updated in it when sorted by **Recently updated**, published in it otherwise), and show 20 to 80 mods per page. Adult mods are included; the **Adult (18+)** entry at the top of the category list shows only those. Mods you already have, here or in Vortex, are marked **Installed**. **Download** on a card opens the file picker below.
  - Clicking a mod opens its Nexus page inside the app (with the site's own Description, Files, Posts and Bugs tabs). **Open in browser** opens the page you are on in your web browser. The pages run in their own sandboxed browser session that only shows nexusmods.com (other links open in your web browser), and they remember a Nexus login and the site's cookie choice. A "Manual download" or "Mod Manager Download" clicked there is downloaded by this app.
  - Ads and trackers on these pages are blocked (Settings → Downloads), with Ghostery's blocker and the usual filter lists (EasyList, EasyPrivacy, uBlock Origin's), the same kind Brave uses. The lists are downloaded once and refreshed weekly.
  - Logging in to the Nexus website is separate from the API key: the site has no way to sign in with an API key, and your browser's own login cannot be borrowed (browsers encrypt it for themselves). **Log in to Nexus** on the Browse page opens the sign-in page once; it is remembered, like a browser that restores its session: the login is kept for 30 days of not using it, across restarts and updates. Sign in with email and password there: Google, Discord and other sign-in buttons go to sites outside Nexus, which open in your browser instead. The app's own **Download** buttons only need the API key.
- **AI Assistant** (a page in the sidebar): a chat with your own AI provider, set in Settings → AI assistant: an OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, Ollama, LM Studio and others) or Anthropic, a model name and an API key (stored encrypted; not needed for local models). **Test** checks the connection.
  - It can read everything: your mods (with versions, on/off, conflicts, updates, repair needs, and when each was installed, enabled or disabled), the game's and mods' logs and their grouped problems, this app's own activity log, and the load order. To track a problem down it searches and reads the mod files in the game folder (configs, scripts, ArchiveXL and TweakXL patches, mods' own logs), so it can tell which mod a name in an error belongs to without asking you. It can check for updates, search Nexus, and search the web and read pages (through a hidden, sandboxed browser window, so it works with any provider). Each step shows in the chat.
  - The tokens it uses show live next to the dots while it works (each step's real count as it comes back, and the size of the request on its way), under each answer, and for the whole chat in the header. Providers that report none are estimated and marked ~.
  - It cannot change anything by itself. To enable, disable or update mods, change the load order or deploy REDmods, it shows a card listing exactly what it wants to do; nothing happens unless you press **Approve**. Your next message tells it whether you approved (with the results) or declined.
  - Asked for a mod, it searches Nexus and shows the mod as a card with **Download**, which opens the usual file picker.
  - Answers are formatted for reading: headings, tables, checklists, callout boxes for what matters, and colour on the words that carry the status (red for errors, orange for warnings, green for fine or fixed, yellow for mod names).
  - Settings files (.json, .ini, .toml, .cfg, .xml…) can hold your keys, so the assistant reads them only after you press **Allow** on a card listing them, and never sees a key: before the text leaves the app, keys, tokens and passwords become "[hidden: set, 51 characters, starts "sk-…"]" or "[hidden: empty]". Its file search skips settings files, and hides key-shaped values everywhere.
  - When something must be filled in (an empty API key, say), it shows a small form; **Save** writes your values straight into the file. The assistant learns only that a hidden field was set, never what you typed. For anything else it shows the file with an **Edit** button.
  - **Ask AI** buttons on Game log problems and in a mod's details start a conversation about them. The chat is kept between sessions; **Clear chat** starts over. Web pages are treated as information only, never as instructions.
  - **Long chats.** The app learns how much the model can read at once (its context window): from your provider (llama.cpp, llama-swap, Ollama, LM Studio, vLLM, KoboldCpp, TabbyAPI, LocalAI, Anthropic, OpenRouter, Groq, Mistral, DeepSeek and xAI report it; **Test** in Settings shows it), from Settings → AI assistant → **Context window**, from the provider's "too long" error (each provider's wording is understood, including errors sent with HTTP 200), or, for servers that silently cut a long chat instead (Ollama, KoboldCpp, text-generation-webui), from a reply that read far less than was sent. A window too small for the assistant's instructions and tools (under about 8k tokens) is reported with how to raise it. The header shows how full it is. Near the limit, the model summarizes the older part of the chat (your goals, what it found, what was tried, changed or ruled out, open questions) and the recent turns stay word for word, so it carries on without forgetting. The chat you see is never shortened.
- **Choose files.** Before downloading, a dialog lists every file on the mod's Files tab grouped by category (Main, Updates, Optional, Misc, Old versions, Archived), each with its description, version, size and upload date. Only files in the categories chosen in Settings → Downloads start ticked: Main by default, so you tick any other file yourself. A link to one file ticks just that file. **Select all**, **Select none**, **Suggested** and a tick per category change that. Files already downloaded are marked.
- **Free accounts.** Nexus gives free accounts no direct download links: each file needs one click on "Slow download" on its Nexus page, which hands over a one-time key. The app does everything around that click: files that need it wait in Downloads (**Needs a click**), and the Browse page opens each one's download page in turn. Click **Slow download** (sign in to Nexus there first, once); the download continues in the app and the next file's page opens by itself. This covers everything that downloads: picked files, requirements, updates and imported profiles. The app never clicks for you: Nexus does not allow automating it, and accounts that do it get banned. With Premium none of this appears.
- **Downloads** the ticked files directly through the API (with Premium; see above for free accounts), the same file the site's "Manual download" button gives you. The Downloads page shows each download's progress, speed and time left in an **In progress** panel, with the total speed above it.
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
- **Sort** (next to the Mods filters): A to Z, Z to A, recently installed or updated, recently enabled, recently disabled, or priority. The recent ones show under each mod when it happened ("enabled 2 h ago"), to find what changed when the game stops working. Enable and disable times are recorded from version 1.1.10 on; Vortex mods only when switched from this app.
- **Mod config** (a page under Mods): every mod's files, enabled or not: this app's, Vortex's, and folders of files no mod manager put in the game folder. Click a mod for a tree of its files, with paths from the game folder; files a mod made itself (settings, logs) are listed with it. Point at a text file and click the pencil to open it in the built-in editor:
  - Colours for redscript, Lua, JSON, YAML/ArchiveXL, TweakXL, INI/TOML, XML and logs; line numbers; Tab/Shift+Tab indent; the search box in the top right finds (Ctrl+F goes to it; Enter / Shift+Enter or F3 for the next and previous match); Ctrl+S saves.
  - It saves in place (hardlinked copies stay linked) and keeps the file's line endings and encoding. Before the first save it keeps the original in the app's own folder (never where the game loads it): **Restore original** puts it back.
  - If the mod or the game changed the file while it was open, it asks before overwriting. JSON is checked before saving.
  - A disabled mod's files are its stored copy: changes apply when it is enabled. **Edit files** in a mod's details opens its files here.
- **Load order** (a page under Mods): archive mods load top to bottom, and when two change the same thing, the one higher up wins (the game's rule). **Auto-sort** asks Nexus what each mod requires and puts every mod above the mods it needs, so add-ons and patches win over what they change; everything else keeps its place, and **Undo** puts it back. Drag rows (or Alt+↑/↓) to override. The order is written to `archive\pc\mod\modlist.txt`, which always lists every archive and takes in newly installed ones by name; **Reset to alphabetical** removes it. REDmods load after all archives, by folder name.
- **Versions** of one mod share one row, as in Vortex (for example ArchiveXL 1.28.3 and 1.28.6). The Version column becomes a menu: picking another version switches to it in one step.
- **Requirements under each mod.** Beneath every mod, the mods it needs are listed as smaller inset rows on a tree line, each with its own switch, status and version. Switching one switches the real mod, and every copy of it follows.
  - Where they come from: the mod's Nexus requirements (read in the background, no API key needed, refreshed every few days), plus what its files show (`.reds` scripts need redscript, `.xl` files ArchiveXL, `r6/tweaks` TweakXL, CET mod folders CET, RED4ext plugins RED4ext).
  - Authors often list Nexus mods as "off-site" requirements ("CET (No REDMOD version)"). Those are matched to the Nexus mod: by the link they give, by a framework's name, or by an exact name search on Nexus. REDmod shows as **Part of the game** when its tools are installed, **Not installed** otherwise.
  - A requirement that is off shows **Off**; one not installed shows **Missing** with **Download**; one installed by hand or by another tool shows "In the game folder, not managed here" (no switch); one hosted off Nexus links to its page. Each row notes who else needs it and what it needs itself.
  - A required mod's own row says **Needed by N**. A mod whose requirement is off or missing gets a **Requirement off / missing** tag and counts under **Problems**.
  - Switching off a mod that enabled mods need (from its row, a requirement row, a bulk action or the menu) first lists them and asks. Switching on a mod whose requirement is off offers to switch that on too.
  - Settings → Interface → **Requirements under each mod**: *Always open* (default) or *Collapsed* (one line per mod, click to open).
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
- **Profiles.** A profile is a named set of enabled mods with its own conflict order. The **Profiles** page shows each profile as a card: how many of this app's mods it has active (out of how many), with the active profile first and marked **Active**, and below them what loads whatever the profile: Vortex's mods (they follow Vortex's own profile; **Move to this app** puts them in profiles) and files no mod manager put in the game folder. From there you can activate a profile, create one (empty, or copied from what is enabled now), rename, export or delete it. The active profile follows every enable and disable you make. Vortex's profiles are listed below yours, read-only.
- **Sharing profiles.** Each profile's details panel has **Copy code** (and **Export file** under it): a share code (`CMM1-…`, a few hundred characters for a big profile) that holds the profile's **enabled, installed** mods with their exact Nexus file IDs, in priority order, and the options picked in FOMOD installers. The code is made from the profile itself, so it changes whenever you enable, disable, reorder or update a mod; the card shows a short tag of the current code. Nothing is uploaded anywhere: the code is the data. Mods moved over from Vortex, or installed from a file named like a Nexus download, know their Nexus mod but not the exact file: the app looks that file up on Nexus by the installed version (right after they come in, and once at startup), so they are in codes, and get update checks, like any Nexus mod. Mods installed from local files can't be in a code (they aren't on Nexus); the receiver is told how many there were. The export button (share icon) saves the profile as a file instead: a **.zip** (the default when the profile has mods from local files) carries those mods too (each one's original archive, or the files it installed if the archive is gone), with `profile.json` and `share-code.txt` (the code) inside; if any packed mod carries program files (.dll, .asi, .exe), the export lists them and says that browsers and virus scanners often flag such files (usually wrongly for game mods), so you know what you are sharing; a `.cmmprofile.json` holds the Nexus mods only. Send any of them to anyone. They drag the .zip onto the app (or choose **Import** and pick it, paste the code, or choose the .json) and see a review of every mod; mods from the zip show as **In the zip** and install into the new profile in the sender's order:
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
  - CET and each CET mod, RED4ext and each RED4ext plugin, redscript, ArchiveXL, TweakXL, Codeware, Input Loader, Mod Settings, ReShade, and any other `.log` under `bin/x64`, `red4ext`, `r6/logs`, `engine`, `tools` or `mods`, plus REDmod's deploy log (`REDmodLog.txt`) and crash reports mods write in their `logs` folders.
  - While the game runs, the whole install is checked every 30 seconds: a text file that appears or grows during the run is a log some mod writes, wherever it is. It is followed from then on and remembered for later starts.
  - Rotated session logs are grouped, and only the current one is followed.
  - **Problems** groups repeated errors and warnings, with a count for each.
  - **Sources** lists every log file, with buttons to open it or show it in its folder.
  - It detects when the game starts and stops, and notices new crash reports from the game's crash reporter.
  - Errors from a mod's own folder are counted on that mod in the Mods list (filter: **Problems**) and shown in its details panel.
- The **Activity** line at the bottom (its drawer: **Manager activity**) shows the app's own info, warning and error messages, and opens by itself when an error happens. It can be resized. Logs are also written to `%APPDATA%\Cyber Mod Manager\logs`.
- **Crashes** (a Game log tab) lists every crash the game's crash reporter recorded (`%LOCALAPPDATA%\REDEngine\ReportQueue`), newest first: what happened, the DLL it happened in and that DLL's mod (read from the crash dump), and whether the same DLL was in other crashes. Opened, a crash shows the errors and warnings from the 10 minutes before it, the crash logs mods wrote then, the game's last log lines and the mod DLLs that were loaded. A crash also shows in the timeline and as a notice. **Ask AI why** has the assistant read it all (and your earlier crashes) and say what caused it and how to fix it. **Its play** opens the logs of the play the crash ended. Crash reports can be deleted one by one or all at once (this removes their folders from the game's report queue).
- **Display.** The app follows the scale Windows sets for each display (Settings → System → Display → Scale), on any resolution or aspect ratio, and moves with the window to a display with another scale. Settings → **Interface** → **Interface scale** uses another scale instead (75% to 250%), for text and everything else; it says what scale is shown now. **Ctrl +** and **Ctrl −** change it at any time, **Ctrl 0** goes back to Automatic. A scale too large for the display is limited to the largest that still fits the app. On very wide screens the pages keep a readable width, centred.
- **Plays.** Every launch of the game, until it exits or crashes, keeps its own set of logs: the timeline of that play and a copy of every log the game and its mods wrote during it (many mods start their log over on the next launch; the copy keeps the old one). The dropdown at the top of the Game log shows **Live** while the game runs; once it closes, that play becomes **Latest**, and earlier plays are listed by date, newest first, each with its length, how it ended and its errors; crashed plays stand out in red. The Game log moves to Live when the game starts and to Latest when it closes (unless you picked an earlier play). Picking one shows only that play's timeline, problems, crash and saved log files (under Sources). **Ask AI about this play** has the assistant look at it and compare it with your other plays; the assistant sees each play as a separate session (`get_plays`, `read_play_file`). Delete one play, or tick several under **Delete plays…**. The last 25 plays are kept (Settings → Advanced → **Game log: plays to keep**), in `%APPDATA%\Cyber Mod Manager\logs\plays`.
- **Manager** (a Game log tab) is this app's own record, newest first: what was enabled or disabled (by name and version), installed, updated, switched. It is kept across restarts (`logs\manager-history.jsonl`, the last 3,000 lines) and is not part of exported reports.
- **Export report.** The Game log and the Activity drawer both export the same single `.json` report: every error and warning from the game's and mods' logs, grouped with how often and when each happened and also listed in full, which mod each one comes from, and every mod (this app's and Vortex's) with its version, on/off state, type, conflicts, repairs needed and available updates.

## Display

The window opens at a size based on your screen and remembers where you left it. All sizes are in `rem`, and the root size scales with the window's width and height, so the layout fits any resolution, aspect ratio (16:9, 16:10, 21:9, 32:9, 5:4) and Windows scale factor. Fixed-shape elements (icons, switches, dots, buttons, images, dialogs) keep their aspect ratio. Narrow windows switch the sidebar to an icon rail and hide less important columns. **Ctrl +**, **Ctrl −** and **Ctrl 0** zoom the whole UI. `node tools/capture.js <dir>` screenshots every screen at 13 display setups for design review.

## Living alongside Vortex

**Vortex mods can move here for good.** Settings → Vortex → **Mods added in Vortex**: *Move them into this app automatically* takes over every Vortex mod (and every one added later) whenever Vortex is closed, so profiles and share codes cover them: Vortex switches them off and keeps them, their files are linked from disk (no downloads), and mods already here are matched instead of added twice. The default asks once.

When Vortex is installed, its Cyberpunk 2077 mods appear in the Mods list with a **Vortex** tag (filter: **Vortex**). Their on/off state is read live from Vortex's deployment record (`<game>\vortex.deployment.json`), and their Nexus IDs, versions and profiles from Vortex's own state snapshots.

- **Enable / disable** a Vortex mod here without opening Vortex. The new state is recorded with Vortex's own command line (`Vortex.exe --set …`, which changes Vortex's data and quits without a window), and the mod's files are hardlinked into or removed from the game folder here, the same way Vortex's hardlink deployment does it, with `vortex.deployment.json` updated to match (the version Vortex last wrote is kept once as `vortex.deployment.json.cmm-backup`). Vortex then finds everything as it expects.
  - Vortex locks its data while it is open. If it is open, it is closed for a moment and reopened after the change (you are asked once first).
  - Files that two Vortex mods both ship, or that are already in the game folder from somewhere else, follow Vortex's own rules: they are left for Vortex, which sorts them out the next time it starts.
  - Each Vortex mod's Type is worked out from its files, and the **Vortex** tag sits in the Type column.
- **Check for updates** includes Vortex mods. **Update** on a Vortex mod moves it to this app (see below) and updates it here; Vortex is not opened.
- **Move my Vortex mods here** (Settings → Vortex) moves every Vortex mod into this app in one go; **Move to this app** in a Vortex mod's details moves just that one. Each keeps its files (linked from Vortex's staging folder, so no extra disk space), name, version, Nexus IDs and on/off state, and its archive when Vortex still has it (so Reinstall works). A mod that won a shared file in Vortex gets the higher priority here, so the game ends up with the same files. In Vortex the moved mods stay installed but switched off: enable them there to go back. Moved mods are no longer listed as Vortex mods. Vortex is not opened (if it is open, it closes for a moment).
- Reinstall, uninstall and delete for Vortex mods stay in Vortex.
- A mod of this app that writes the same file as a Vortex mod gets a **Vortex N** tag in the Conflicts column. Whichever tool deploys last wins that file, so don't enable the same mod in both. If this app has to overwrite a file that Vortex deployed, it backs that file up first.

## Saves: backups and separate saves per profile

**Saves** (in the sidebar, the page "Manage saves") shows your Cyberpunk 2077 saves grouped by playthrough (one character's run, with its latest screenshot, life path, level, play time and game version), and every backup of them, by day.

- **Automatic backups**, before you play from this app, and when the game starts from Steam or elsewhere: always right away when your mods changed since the last backup; otherwise once the time set in Settings has passed (an hour by default). No backup while nothing was played (the saves are exactly as in the last one). **Back up now** makes one any time.
- **Restore** a backup: the saves you choose (all ticked: every save in it comes back, saves in other slots stay), or replace all your saves with the backup's. Your saves as they are now are always backed up first, so a restore can be undone. Never while the game runs.
- Backups can be **named** and **pinned**. Settings → Save manager sets how many are kept per profile (20 by default; pinned ones, and the ones made before a restore in the last 7 days, are always kept), the time between automatic backups, and where they go.
- Backups are plain folders, by day, in `%USERPROFILE%\Saved Games\Edgerunners Mod Manager\Save backups` (outside the app and outside the game's save folder, which cloud saves sync). Each file is stored once and shared between backups (hard links), so a new backup costs only the saves that changed. The game's own settings files beside the saves (`user.gls`, which holds your CD PROJEKT RED sign-in, and the others) are never copied.
- **Separate saves for each profile** (Settings → Save manager, or the setup wizard; off by default): switching profiles swaps your saves too. The profile in use keeps its saves in the game's folder; the others wait in `Saved Games\Edgerunners Mod Manager\Profile saves`. Every switch makes a backup first and only happens with the game closed. Switching to a profile with no saves asks: start fresh, or copy your current saves. On the Saves page, **Active profile** lists this profile's playthroughs (**Copy to profile…** gives one to other profiles), and **Other profiles** lists theirs: open one to copy a single save into this profile, or copy the whole playthrough. A copy never replaces a save that is already there.
- A switch never deletes or overwrites a save: a slot name already taken where a save goes gets the next free manual save number. A switch the app is stopped in the middle of (a crash, a power cut) is undone the next time it starts. Deleting a profile keeps its saves, in `Profile saves\Deleted profiles`.
- Cloud saves (Steam, GOG) can bring a save that was swapped out back into the game's folder; it then also shows up in the profile in use (a duplicate, nothing lost). Separate saves work best with cloud saves off for Cyberpunk.
- **Uninstalling** never removes backups or profile saves. The uninstaller says where they are and offers to open the folder; `README.txt` there lists every folder and how to use the saves without the app.

Research and rules: `notes/saves.md`.

## Coming from Mod Organizer 2

Mod Organizer 2 setups for Cyberpunk 2077 are found by themselves: global instances (`%LOCALAPPDATA%\ModOrganizer\<name>`), and portable ones wherever MO2 is installed. MO2's installer leaves no uninstall entry (and a portable or Wabbajack MO2 none at all), so the app finds MO2's folder from its Start Menu shortcut, Windows' records of programs that ran, its download handler, and the usual folders on each local drive (`\Modding\MO2`, `\MO2`, `\Modlists\<list>` …), keeping only folders that still hold `ModOrganizer.exe`. Anything else: Settings → Mod Organizer 2 → **Add a folder**. When MO2 is installed but has no Cyberpunk 2077 setup yet, Settings says where it is.

**MO2 is only read, never changed.** MO2 doesn't put its mods in the game folder (it overlays them only for programs it starts), and it rewrites its own files while it runs, so this app never writes into an MO2 setup. A game started from this app (or Steam) gets only this app's mods; started from MO2, MO2 adds its own enabled mods on top.

- **Use here** on an MO2 profile (Profiles page) brings the mods it enables into this app and makes a profile "<name> (MO2)" with exactly those mods, in MO2's order (the mod lower in MO2's list wins a shared file here too), and switches to it. Using it again updates that profile. **Show its mods** lists them first, marking those already here.
- **Bring its mods here** (Settings → Mod Organizer 2) adds every mod of a setup, switched off, in MO2's order.
- Moving a mod links its files from MO2's mod folder (no copies, no extra space; copied only across drives), puts a `root/` folder (RootBuilder) at the game root, and links its archive into this app's downloads when MO2 still has it. Name, version, Nexus IDs and file category come from MO2's `meta.ini` and the download's `.meta`, so moved mods get update checks and go into share codes. A mod already here (moved before, or the same Nexus file) is matched instead of added twice. Separators and MO2's backup folders are skipped.
- Settings files a mod rewrites while the game runs (`.json`, `.ini`, `.yaml`, `.sqlite` …) are copied instead of linked, so MO2's copy never changes.
- Left in MO2: empty mods, and the "disable CrashReporter" mod MO2's Cyberpunk plugin makes (an empty `CrashReporter.exe` that only matters inside MO2, and would break the game's crash reporter here).
- Not carried over: MO2's `overwrite` folder (logs, caches and settings the game wrote while running from MO2).

Formats and sources: `notes/mo2.md`.

## Data

`%APPDATA%\Cyber Mod Manager\` (the folder keeps its original name, so updating from Cyber Mod Manager keeps everything): `settings.json` (the API key is encrypted with Windows DPAPI), and `data\` (downloads, staging, backups, `library.json`, `deployment.json`).

## Releases

Every push to `main` publishes a new version (`.github/workflows/release.yml`, on GitHub's Windows runners): the tests run, the app is built with electron-builder, and a GitHub release `v1.1.<build number>` is published with the installer and `latest.yml`, which installed copies check. A push never ships a key: `tools/check-secrets.js` scans every tracked file, and then everything inside the built app, for API keys and tokens, and stops the release on any hit. The app's own settings (where your API key is kept, encrypted) live in `%APPDATA%\Cyber Mod Manager` and are never part of the repository or the build.

## Build it yourself

What GitHub's release build does, on your own PC (Windows 10/11):

1. Install [Git](https://git-scm.com/download/win), [Node.js 24](https://nodejs.org/) and [7-Zip](https://www.7-zip.org/) (the app ships 7-Zip's own program, unchanged, to unpack mods).
2. Get the code and its packages:
   ```
   git clone https://github.com/skyehosting/edgerunners-mod-manager.git
   cd edgerunners-mod-manager
   npm ci
   ```
   To build one exact release, check out its tag first, e.g. `git checkout v1.1.61`.
3. Run the tests (optional): `npm test`
4. Add 7-Zip to the build (PowerShell):
   ```
   New-Item -ItemType Directory -Force build\7zip
   $7z = "C:\Program Files\7-Zip"
   Copy-Item "$7z\7z.exe","$7z\7z.dll","$7z\License.txt" build\7zip
   ```
5. Build the installer: `npm run dist`. It lands in `dist\Edgerunners-Mod-Manager-Setup-<version>.exe` (GitHub's builds stamp the release number in first; a local build keeps the version in `package.json`).

To run the app straight from the code instead, `npm start` after step 2.

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

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md), with credit required. Free to use, change and share for any non-commercial purpose. Selling it, charging for it, or making money from it or from work based on it is not allowed, and every copy or fork must keep the notice crediting skyehosting and linking here. Releases up to v1.1.57 were published under MIT and stay under MIT. 7-Zip, which the installer bundles, keeps its own license.
