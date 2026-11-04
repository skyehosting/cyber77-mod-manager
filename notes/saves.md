# Saves, backups and per-profile saves: research

Researched 2026-11-04 (three researchers, sources in the session's findings; this is the summary
the code relies on). Observed on a real PC: 90 saves, 293 MB, Steam Cloud on.

## The save folder
- `%USERPROFILE%\Saved Games\CD Projekt Red\Cyberpunk 2077\` (CDPR support; all stores).
- A save is a folder `ManualSave-N | AutoSave-N | QuickSave-N | PointOfNoReturnSave-N | EndGameSave-N`
  with exactly three files: `sav.dat`, `screenshot.png`, `metadata.9.json`. Treat it as one unit;
  never change a byte of it (CyberCAT, Formenel's CP77-SaveGame-Manager).
- AutoSave has 20 slots (0-19), QuickSave 10 (0-9): the game overwrites the OLDEST slot. ManualSave
  numbers only grow, with gaps. Overwriting a slot deletes and recreates its folder and files (new
  birth times): the game does not rewrite saves in place (inferred from timestamps).
- The slot name is not stored in `sav.dat`; `metadata.9.json` "name" equals the folder name. The
  RED Modding wiki documents renaming save folders. `.9` has not changed since game 1.04.
- `metadata.9.json` → `Data.metadata`: playthroughID (groups a character's saves), level, lifePath,
  bodyGender, locationName, playthroughTime, buildPatch/gameVersion, isModded, additionalContentIds
  (EP1 = Phantom Liberty), timestampString ("HH:MM:SS, D.MM.YYYY"). Optional keys vary: tolerate gaps.
- Loose files are global and are never backed up or moved: `user.gls` (the last save's name AND the
  player's CD PROJEKT RED sign-in token: never copy it anywhere), `EnabledMods.json` (in-game mod.io
  list, 2.5+), `HDRUserSettings.json`, `steam_autocloud.vdf` (Steam's marker), and the user's own files.

## Compatibility
- Saves from older patches load in newer ones. Newer-to-older (e.g. a 2.5 save on 2.31) is not
  supported and reported to fail: flag the save's version.
- Mods that store data in saves (redscript persistent fields, NG+ Native, some weather mods) need to
  be present: loading and re-saving without them strips that data for good. Hence "made with" info.

## Cloud sync (the risk for moving saves)
- Steam Auto-Cloud for app 1091500 syncs EVERYTHING under the folder (`*`, recursive), 2 GB and
  1000 files, at game launch (down) and exit (up); at Steam start it only compares. Deletions made
  during a Steam-tracked session propagate; what Steam does with folders moved out while the game is
  closed is undocumented (not testable without risking the real cloud).
- GOG Galaxy users report deleted Cyberpunk saves coming back, or conflict prompts.
- CDPR cross-progression uploads the latest save of each type (in-game setting).
→ Nothing of this app's goes inside the save folder. Backups only copy. Moving saves between
  profiles always takes a backup first. A save a cloud restores into the game's folder counts as the
  profile in use's (a duplicate at worst): telling a cloud copy from the user's own copy is not
  reliable, and deleting the wrong one loses progress (audit PS-1/PS-2). The app recommends turning
  cloud saves off for Cyberpunk when per-profile saves are used.

## Per-profile saves (design)
- The profile in use keeps its saves in the game's folder; the others in `Profile saves<id>`.
- A switch never deletes or overwrites: a taken slot name gets the next free ManualSave number.
- Every move is journaled first (`Profile saves.switch.log`, fsynced per line). The journal goes only
  after the new owner is saved; at start (and before the next switch) a leftover journal is undone,
  unless the recorded owner is already its new profile.
- The game check runs fresh (tasklist) right before moving, and counts as running for 20 s after
  the game exits (cloud upload).
- A deleted profile's saves move to `Profile savesDeleted profiles<name> <date>`.

## Backups (design)
- Plain folders outside the app and outside the save folder:
  `%USERPROFILE%\Saved Games\Edgerunners Mod Manager\Save backups\<day>\<time> <reason>\` + backup.json.
  Uninstalling the app never removes them.
- Each file is stored once (`.store\<2>\<sha256>`, copied and hash-checked from the live save) and
  backups hard-link to it: a backup costs only what changed. NTFS: 1023 links per file, measured;
  any link failure falls back to a copy. No links possible (another drive type): plain copies.
- Restored files are fresh copies, never links.

## Uninstall (electron-builder 26.17 NSIS)
- `build/installer.nsh` `!macro customUnInstall` runs before any file is removed. Every update runs the
  OLD uninstaller silently with `--updated`: guard with `${ifNot} ${isUpdated}`. electron-builder's
  uninstaller runs that section in silent mode either way; a MessageBox without `/SD` still shows
  (tested with this NSIS), and a user's own `/S` is read from the command line (GetParameters/GetOptions).
- Chosen: no saves are moved back on uninstall (several profiles' slot names would collide). The
  uninstaller points to the folder when README.txt is there; the app keeps README.txt current.
- `%APPDATA%\Cyber Mod Manager` is kept on uninstall (deleteAppDataOnUninstall false).
