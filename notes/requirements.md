# Requirements on the Mods page: decision

Chosen 2026-11-04 from three mockups (`.design/deps-1..3.html`, not in git): **Direction 1, nested
tree**. Under each mod, its requirements show as smaller inset copies on a tree line, each with its
own switch, status and version. Rejected: a one-line strip of switch-chips (2), and a framework band
with a dot matrix (3).

Why: the operator wants to see and flip requirements right where the mod is. The cost is a longer
list, so a setting (Settings → Interface → **Requirements under each mod**) offers *Always open*
(default, the operator's preference) or *Collapsed* (one summary line, click to open).

Rules agreed with the operator:
- A copy is a view of the real mod: switching it switches the real mod, and every copy follows.
- Switching off a mod that enabled mods need, from anywhere (its row, a copy, bulk, the menu), first
  lists those mods and asks.
- Switching on a mod whose requirement is off offers to switch that on too.
- A requirement not installed shows **Missing** with Download; one installed outside the manager
  shows "In the game folder, not managed here" without a switch; one hosted off Nexus shows a link.
- One level deep: a copy notes what it needs itself ("needs RED4ext") instead of nesting.
- "Needed by N" on a required mod's own row.
- Theme colours only (every built-in theme and custom themes).

Sources: Nexus requirements (public GraphQL, no API key needed), cached per mod for a few days, plus
what a mod's own files show (`.reds` → redscript, `.xl` → ArchiveXL, `r6/tweaks` → TweakXL, CET mod
folders → CET, `red4ext/plugins` → RED4ext).
