# Mod Organizer 2 support: research and design

Researched 2026-11-03 against MO2 2.5.2 (latest release; a copy is installed at `C:\Modding\MO2`), its
source (github.com/ModOrganizer2/modorganizer, tag v2.5.2 and master), modorganizer-uibase, the
basic_games Cyberpunk plugin 2.3.1 (`plugins/basic_games/games/game_cyberpunk2077.py`) and 3.0.x,
RootBuilder (github.com/Kezyma/ModOrganizer-Plugins) and Qt's QSettings source.

## How MO2 differs from Vortex

- **MO2 never puts its mods in the game folder.** Enabled mods are overlaid with a virtual file
  system (USVFS) only for programs started from MO2 (`organizercore.cpp` fileMapping; the plugin's
  `GameDataPath = "%GAME_PATH%"`). Files the game writes while running from MO2 land in the
  instance's `overwrite/` folder. RootBuilder (plugin 2.x) copies a mod's `root/` files into the game
  before a launch from MO2 and removes them afterwards; plugin 3.x drops RootBuilder.
- **Editing MO2's files from outside is not safe while it runs.** MO2 keeps the mod list in memory,
  has no file watcher on `modlist.txt`, rewrites it 200 ms after any change, before every launch and
  at exit (`profile.cpp` writeModlist / doWriteModlist, uibase `delayedfilewriter.cpp`), and its own
  write is not atomic in 2.5.2 (delete then rename, `safewritefile.cpp`; issue #2445). There is no
  command line to switch a mod on or off (`commandline.cpp`: run, reload-plugin, download-file,
  refresh, crashdump). Closing it from outside can stop at a dialog (downloads running) or wait for
  a game started through it (`mainwindow.cpp` canExit).

**Design decision:** this app only READS MO2. It never writes into an MO2 instance. Unlike
Vortex, MO2's mods do not touch the game folder, so nothing there needs switching off: a game
started from this app (or Steam) gets only this app's mods. Started from MO2, MO2 adds its own
enabled mods on top; the UI says so.

## Finding instances

- Global instances: every subfolder of `%LOCALAPPDATA%\ModOrganizer` that holds a
  `ModOrganizer.ini` (`instancemanager.cpp` globalInstancePaths; the folder name is the instance
  name). The registry value `HKCU\Software\Mod Organizer Team\Mod Organizer\CurrentInstance` names
  the last used one (empty = portable / none).
- Portable instances: a `ModOrganizer.ini` next to `ModOrganizer.exe` (`portableInstanceExists`).
  The installer writes no uninstall key (`CreateUninstallRegKey=no`), and a portable MO2 (unpacked by
  hand, or by Wabbajack, which always uses a portable MO2) leaves nothing at all, so MO2 folders are
  found from:
  - the default `<system drive>\Modding\MO2` (`MO2-Installer.iss` DefaultDirName)
  - the installer's all-users Start Menu shortcut `Mod Organizer\Mod Organizer.lnk` (its target)
  - Windows' records of programs that ran: `HKCU\Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache`
    (`<exe>.FriendlyAppName`) and `HKCU\...\AppCompatFlags\Compatibility Assistant\Store` (`<exe>`).
    These outlive the program (this PC kept a deleted Nolvus MO2), so a folder counts only while it
    holds `ModOrganizer.exe`
  - the nxm handler command when it points at an MO2 `nxmhandler.exe`, and the `executable` entries of
    `nxmhandler.ini` / `downloadhandler.ini` in `%LOCALAPPDATA%\ModOrganizer`
  - common folders on each local (fixed) drive: `\Modding\MO2`, `\MO2`, `\Mod Organizer 2`,
    `\Games\MO2`, and one level under `\Modlists`, `\Wabbajack`, `\Modding` (Wabbajack lists such as
    PunkCity install to e.g. `D:\Modlists\PunkCity`)
  - folders the user adds in Settings.
  Guides say never to put MO2 inside the game folder, so it is not searched.
- An instance is for Cyberpunk when `[General] gameName` equals `Cyberpunk 2077`
  (case-insensitive, as MO2 compares; plugin `GameName`).

## ModOrganizer.ini (Qt QSettings INI)

- `[General]`: `gameName` (plain), `gamePath` and `selected_profile` as `@ByteArray(...)` (bytes,
  non-ASCII as `\xHH`, decoded as UTF-8), backslashes doubled.
- `[Settings]`: `base_directory` (default: the folder of the ini), `mod_directory`,
  `download_directory`, `profiles_directory`, `overwrite_directory`, each defaulting to
  `%BASE_DIR%/<mods|downloads|profiles|overwrite>`; `%BASE_DIR%` is replaced by the base.
- Section and key names are case-insensitive; values may be quoted; `\\`, `\"` escapes.

## Profiles and mods

- `profiles/<name>/modlist.txt`: a `#` header, then one line per mod: `+Name` enabled, `-Name`
  disabled, `*Name` foreign (none for Cyberpunk). **The first line is the HIGHEST priority** (wins
  file conflicts); MO2's window shows it reversed (`profile.cpp` writer iterates crbegin..crend).
  Names with no folder are dropped; folders not listed count as disabled and highest priority.
- Separators: folders named `*_separator`. Backups: folders named `*backup[0-9]*`. Both are skipped.
- `mods/<name>/meta.ini` `[General]`: `modid`, `version`, `installationFile` (a file name in the
  downloads folder, or an absolute path), `nexusFileStatus` (1 MAIN, 2 UPDATE, 3 OPTIONAL,
  4 OLD_VERSION, 5 MISCELLANEOUS, 7 ARCHIVED), `author`. The installed Nexus file id is only in
  `[installedFiles]` (`size=N`, `1\modid=`, `1\fileid=`; the newest pair last).
- `downloads/<archive>.meta` `[General]`: `modID`, `fileID`, `modName`, `version`, `name`.
- Mod folders are laid out like the game folder. A top-level `root/` folder (RootBuilder) goes to
  the game root: `root/bin/x64/version.dll` is `bin/x64/version.dll` in the game.
- MO2's Cyberpunk plugin 3.x makes a mod "disable CrashReporter (MO CET fix)": an empty
  `bin/x64/CrashReporter/CrashReporter.exe`, needed only under MO2's virtual files. It is skipped,
  as are mods with no files.
- `overwrite/` is shared by all profiles and holds what the game wrote while running from MO2
  (logs, the redscript cache, CET mods' settings). Not carried over (yet).

## What this app does with it

- Settings → Mod Organizer 2: the instances found (and a way to add a folder), each with its
  mods and profiles, and "Move its mods here".
- Profiles: every MO2 profile, with "Show its mods" and "Use here" (as for Vortex): its mods this
  app lacks are moved in, then a profile "<name> (MO2)" gets exactly its enabled mods, in MO2's
  order, and becomes active. Using it again updates that profile.
- Moving a mod: its files are hardlinked from MO2's mod folder into this app's staging (no extra
  space; copied across drives; settings files a mod rewrites, such as `.json` and `.ini`, are always
  copied so MO2's copy never changes), `root/` mapped to the game root, its archive linked into this app's
  downloads when MO2 still has it. Name, version, Nexus ids and category come from `meta.ini` and
  the download's `.meta`. A mod this app already has (same Nexus file) is matched, not added twice.
- MO2's priority order carries over: mods moved together are placed in MO2's order (lowest first,
  so the one that won in MO2 wins here).
