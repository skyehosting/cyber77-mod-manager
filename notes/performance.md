# Performance page: where the numbers come from

Research for `src/core/perf.js` and `src/core/perfWin.cs` (2026-11-05). Sources are listed per point;
"checked" means it was run on a Windows 11 PC (RTX 4070 Ti), "documented" means from the docs only.

## Windows

- **One PowerShell child, a C# sampler.** `powershell.exe -NoProfile -NonInteractive -EncodedCommand`
  with a short script that reads the C# from standard input (`[Console]::In.ReadToEnd()`) and compiles it
  with `Add-Type`. The C# itself is too long for a Windows command line (ENAMETOOLONG at ~33 KB
  encoded). Add-Type took 110-160 ms here. *Checked.*
- **English counter names on any display language:** `PdhAddEnglishCounterW` (Vista+). Wildcard
  paths stay wildcards in the query; `PdhGetFormattedCounterArrayW` (called first with size 0, answer
  `PDH_MORE_DATA`) returns every instance. Item layout on x64: name pointer, status, value at +16
  (24 bytes). Rates need two collections. typeperf and Get-Counter take localized names only, so
  they are not used.
  <https://learn.microsoft.com/en-us/windows/win32/api/pdh/nf-pdh-pdhaddenglishcounterw>,
  <https://learn.microsoft.com/en-us/windows/win32/api/pdh/nf-pdh-pdhgetformattedcounterarrayw>. *Checked
  (en-US); other languages documented.*
- **Counters:** `\Processor Information(_Total)\% Processor Utility` (falls back to
  `\Processor(_Total)\% Processor Time`; capped at 100), `\GPU Engine(*)\Utilization Percentage`,
  `\GPU Process Memory(*)\Dedicated Usage`, `\GPU Adapter Memory(*)\Dedicated Usage`,
  `\PhysicalDisk(_Total)\Disk Read|Write Bytes/sec`, `\Network Interface(*)\Bytes Received|Sent/sec`
  (loopback and virtual adapters left out), `\Process(Cyberpunk2077)\Working Set - Private`. *Checked.*
- **GPU %, as Task Manager counts it:** the busiest engine. GPU Engine instances
  (`pid_<pid>_luid_0x…_0x…_phys_0_eng_<n>_engtype_3D`) are summed per engine, then the highest engine
  is the adapter's figure; for the game, only its own `pid_<pid>_` instances.
  <https://devblogs.microsoft.com/directx/gpus-in-the-task-manager/>. *Documented; the summing per
  engine is our reading.*
- **Which graphics card, its name and video memory:** DXGI (`CreateDXGIFactory1`, `EnumAdapters1`,
  `GetDesc1`: name, LUID, dedicated video memory, without the 4 GB cap of `Win32_VideoController`). The
  card the game draws on while it runs, else the one with the most video memory. *Checked.*
- **The game's CPU:** `Process.TotalProcessorTime` between readings ÷ elapsed time ÷ logical
  processors (Task Manager's per-process figure since Windows 11 24H2). Disk: `GetProcessIoCounters`
  (all of the process's I/O, files included). A process that starts after the sampler is picked up.
  *Checked.*
- It ends by itself when the app's process is gone. If PowerShell cannot run it (blocked,
  Constrained Language Mode), the page still shows CPU and memory from Node.

## Linux (desktops, Steam Deck)

- CPU: `/proc/stat` first line, busy = total − idle − iowait.
  <https://man7.org/linux/man-pages/man5/proc_stat.5.html>
- Memory: `/proc/meminfo` MemTotal − MemAvailable (MemAvailable since 3.14).
  <https://man7.org/linux/man-pages/man5/proc_meminfo.5.html>
- Disk: `/proc/diskstats`, whole disks only (sd*, nvme*n*, vd*, xvd*, mmcblk*), fields 6 and 10 in
  512-byte sectors. <https://docs.kernel.org/admin-guide/iostats.html>
- Network: `/proc/net/dev`, every interface but `lo` (receive bytes, transmit bytes).
- The game: found as `gameProcess.js` does (the first argument ends in `Cyberpunk2077.exe`; Proton's
  helpers name it later on their command lines). `/proc/<pid>/stat` fields 14 + 15 (read after the
  last `)`), in 1/100 s; `status` VmRSS; `io` read_bytes / write_bytes.
  <https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html>,
  <https://man7.org/linux/man-pages/man5/proc_pid_io.5.html>
- GPU, AMD: `/sys/class/drm/card*/device/` `gpu_busy_percent`, `mem_info_vram_used`,
  `mem_info_vram_total` (vendor file `0x1002`; the card with the most video memory).
  <https://docs.kernel.org/gpu/amdgpu/thermal.html>, <https://docs.kernel.org/gpu/amdgpu/driver-misc.html>
- GPU, NVIDIA: `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total
  --format=csv,noheader,nounits -lms=<interval>`, left running. Not installed: no GPU numbers.
- GPU, Intel: no file gives its load; not shown (the page says so).
- The game's GPU share and video memory (AMD, Intel): the fdinfo of its `/dev/dri/*` files,
  `drm-engine-<engine>` (ns; % = change ÷ elapsed ns, the busiest engine), `drm-resident-vram` /
  `drm-memory-vram` / `drm-total-vram`, one per `drm-client-id`.
  <https://docs.kernel.org/gpu/drm-usage-stats.html>

Not run on a Linux PC yet: the Proton process's fdinfo and the Steam Deck's card numbering are from the
docs. The tests (`test/perf.test.js`) read a made-up /proc and /sys.
