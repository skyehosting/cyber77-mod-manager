# Mod details panel (Mods page side panel)

## Decision (2026-11-05): Direction 3, "fixed header, tabbed body"

Three mockups were compared (Nexus showcase, Spec sheet, Fixed header + tabs); the user picked 3.

- Top, never scrolls: the mod's picture in a fixed 16:9 frame (cropped, never stretched), the
  name, category and version laid over its lower edge, the close button on the picture.
- A full-width "Open on Nexus Mods" bar (mods with a Nexus page only).
- The actions as sharp-edged buttons in two columns (an odd last one spans both).
- Tabs: Overview (status, details, warnings, update, repair, log problems), Requires, Needed by,
  Conflicts (only when there are any), Files. Only the chosen tab scrolls.

Why: the panel keeps the same shape for every mod, the buttons are always in reach, and a mod with
many requirements or files does not turn into a long scroll. The cost: one section at a time, so
Overview carries a red count of problems and Status items jump to their tab.

## Pictures

- Nexus's `pictureUrl` (GraphQL, public), downloaded once into `<userData>/mod-images/`, with an
  index of which address and mod version each file came from.
- Asked again when the installed version changes (a new version may bring a new picture) or after
  30 days; downloaded again only when the address changed. Fetched in the background when a
  download finishes, so it is there the first time the panel opens.
- Only https images from Nexus hosts, image types only, at most 10 MB.
- Adult mods: the picture is blurred until "Show" (remembered per mod).
- No Nexus page (local files): a neutral placeholder in the same frame.
- Short windows: the picture's frame gets lower (crops more) so the tabs keep room.
