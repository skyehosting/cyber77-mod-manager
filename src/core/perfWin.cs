// The Performance page's sampler on Windows (perf.js sends this file to a PowerShell child, which
// compiles it with Add-Type and calls Sampler.Run). Every interval it prints one JSON line:
//   {"cpu":%,"gpu":{"name","util":%,"vramUsed":B,"vramTotal":B},"disk":{"r":B/s,"w":B/s},"net":{"rx":B/s,"tx":B/s},
//    "game":{"pid","start":ms,"cpu":%,"mem":B,"gpu":%,"vram":B,"ioR":B/s,"ioW":B/s} (absent while the game is not running)}
// Counters are added by their English names (PdhAddEnglishCounter), so any display language works.
// GPU % is Task Manager's: the busiest engine of the adapter. The adapter is the one the game draws
// on, else the one with the most video memory (DXGI gives its name, LUID and memory). It stops when
// the app (parentPid) is gone. Research: notes/performance.md.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace CmmPerf {
  [ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDXGIFactory1 {
    void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
    void EnumAdapters(); void MakeWindowAssociation(); void GetWindowAssociation(); void CreateSwapChain(); void CreateSoftwareAdapter();
    [PreserveSig] int EnumAdapters1(uint index, out IDXGIAdapter1 adapter);
    void IsCurrent();
  }
  [ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDXGIAdapter1 {
    void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
    void EnumOutputs(); void GetDesc(); void CheckInterfaceSupport();
    [PreserveSig] int GetDesc1(out AdapterDesc desc);
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct AdapterDesc {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
    public uint VendorId, DeviceId, SubSysId, Revision;
    public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
    public uint LuidLow; public int LuidHigh; public uint Flags;
  }
  class Adapter { public string Name; public string Luid; public double Vram; }

  public static class Sampler {
    [DllImport("pdh.dll")] static extern uint PdhOpenQueryW(IntPtr src, IntPtr user, out IntPtr q);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhAddEnglishCounterW(IntPtr q, string path, IntPtr user, out IntPtr c);
    [DllImport("pdh.dll")] static extern uint PdhCollectQueryData(IntPtr q);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhGetFormattedCounterArrayW(IntPtr c, uint fmt, ref uint size, out uint count, IntPtr buf);
    [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1([In] ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IDXGIFactory1 f);
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [DllImport("kernel32.dll")] static extern bool GetProcessIoCounters(IntPtr h, out IoCounters io);

    const uint FMT = 0x00000200 | 0x00008000; // PDH_FMT_DOUBLE | PDH_FMT_NOCAP100
    static IntPtr query;
    static readonly Dictionary<string, IntPtr> counters = new Dictionary<string, IntPtr>();

    static void Add(string key, string path) {
      IntPtr c;
      if (PdhAddEnglishCounterW(query, path, IntPtr.Zero, out c) == 0) counters[key] = c;
    }

    /** Every instance's value of a counter (a wildcard one), or an empty list. */
    static List<KeyValuePair<string, double>> Values(string key) {
      var list = new List<KeyValuePair<string, double>>();
      IntPtr c;
      if (!counters.TryGetValue(key, out c)) return list;
      uint size = 0, count;
      uint r = PdhGetFormattedCounterArrayW(c, FMT, ref size, out count, IntPtr.Zero);
      if (r != 0x800007D2 || size == 0) return list; // PDH_MORE_DATA
      IntPtr buf = Marshal.AllocHGlobal((int)size);
      try {
        if (PdhGetFormattedCounterArrayW(c, FMT, ref size, out count, buf) != 0) return list;
        int item = IntPtr.Size == 8 ? 24 : 16, val = IntPtr.Size == 8 ? 16 : 8;
        for (int i = 0; i < count; i++) {
          IntPtr p = new IntPtr(buf.ToInt64() + (long)i * item);
          if (Marshal.ReadInt32(p, IntPtr.Size) != 0) continue; // this value is not valid now
          list.Add(new KeyValuePair<string, double>(Marshal.PtrToStringUni(Marshal.ReadIntPtr(p)) ?? "", BitConverter.Int64BitsToDouble(Marshal.ReadInt64(p, val))));
        }
      } finally { Marshal.FreeHGlobal(buf); }
      return list;
    }
    static double? One(string key) {
      var v = Values(key);
      if (v.Count == 0) return null;
      double s = 0; foreach (var x in v) s += x.Value; return s;
    }

    static List<Adapter> Adapters() {
      var list = new List<Adapter>();
      try {
        var iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
        IDXGIFactory1 f;
        if (CreateDXGIFactory1(ref iid, out f) != 0 || f == null) return list;
        for (uint i = 0; i < 16; i++) {
          IDXGIAdapter1 a;
          if (f.EnumAdapters1(i, out a) != 0 || a == null) break;
          AdapterDesc d;
          if (a.GetDesc1(out d) == 0 && (d.Flags & 2) == 0) // not the software renderer
            list.Add(new Adapter { Name = (d.Description ?? "").Trim(), Luid = string.Format("luid_0x{0:X8}_0x{1:X8}", d.LuidHigh, d.LuidLow), Vram = (double)d.DedicatedVideoMemory.ToUInt64() });
          Marshal.ReleaseComObject(a);
        }
        Marshal.ReleaseComObject(f);
      } catch { }
      return list;
    }

    static string Num(double? v) { return v.HasValue && !double.IsNaN(v.Value) && !double.IsInfinity(v.Value) ? v.Value.ToString("0.###", CultureInfo.InvariantCulture) : "null"; }
    static string Str(string s) {
      var b = new StringBuilder("\"");
      foreach (char ch in s ?? "") {
        if (ch == '"' || ch == '\\') b.Append('\\').Append(ch);
        else if (ch < 0x20) b.AppendFormat("\\u{0:x4}", (int)ch);
        else b.Append(ch);
      }
      return b.Append('"').ToString();
    }

    /** The busiest engine of each adapter (Task Manager's GPU figure), for one process (pid) or all (0). */
    static Dictionary<string, double> EngineLoad(List<KeyValuePair<string, double>> engines, int pid) {
      var perEngine = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
      string want = "pid_" + pid + "_";
      foreach (var e in engines) {
        if (pid != 0 && !e.Key.StartsWith(want, StringComparison.OrdinalIgnoreCase)) continue;
        int l = e.Key.IndexOf("luid_", StringComparison.OrdinalIgnoreCase);
        if (l < 0) continue;
        string engine = e.Key.Substring(l); // luid_..._phys_0_eng_3_engtype_3D: one engine, summed over processes
        double v; perEngine.TryGetValue(engine, out v); perEngine[engine] = v + e.Value;
      }
      var perAdapter = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
      foreach (var e in perEngine) {
        string luid = e.Key.Substring(0, Math.Min(e.Key.Length, 26)); // luid_0x00000000_0x000146F7
        double v; perAdapter.TryGetValue(luid, out v); perAdapter[luid] = Math.Max(v, Math.Min(100, e.Value));
      }
      return perAdapter;
    }
    static double SumFor(List<KeyValuePair<string, double>> list, string prefix, string luid) {
      double s = 0;
      foreach (var e in list) if ((prefix == null || e.Key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) && (luid == null || e.Key.IndexOf(luid, StringComparison.OrdinalIgnoreCase) >= 0)) s += e.Value;
      return s;
    }

    /** Prints one JSON line every intervalMs until the parent (the app) is gone. */
    public static void Run(int parentPid, int intervalMs, string gameName) {
      Process parent = null;
      try { parent = Process.GetProcessById(parentPid); } catch { return; }
      if (PdhOpenQueryW(IntPtr.Zero, IntPtr.Zero, out query) != 0) { Console.Out.WriteLine("{\"error\":\"pdh\"}"); Console.Out.Flush(); return; }
      Add("cpu", "\\Processor Information(_Total)\\% Processor Utility");
      if (!counters.ContainsKey("cpu")) Add("cpu", "\\Processor(_Total)\\% Processor Time");
      Add("eng", "\\GPU Engine(*)\\Utilization Percentage");
      Add("pmem", "\\GPU Process Memory(*)\\Dedicated Usage");
      Add("amem", "\\GPU Adapter Memory(*)\\Dedicated Usage");
      Add("dr", "\\PhysicalDisk(_Total)\\Disk Read Bytes/sec");
      Add("dw", "\\PhysicalDisk(_Total)\\Disk Write Bytes/sec");
      Add("rx", "\\Network Interface(*)\\Bytes Received/sec");
      Add("tx", "\\Network Interface(*)\\Bytes Sent/sec");
      Add("gws", "\\Process(" + gameName + ")\\Working Set - Private");
      var adapters = Adapters();
      int cpus = Environment.ProcessorCount;
      PdhCollectQueryData(query);
      int gamePid = 0; TimeSpan gameCpu = TimeSpan.Zero; IoCounters gameIo = new IoCounters(); DateTime gameAt = DateTime.MinValue;
      while (true) {
        Thread.Sleep(intervalMs);
        if (parent.HasExited) return;
        PdhCollectQueryData(query);
        var engines = Values("eng");
        var amem = Values("amem");
        var pmem = Values("pmem");
        var all = EngineLoad(engines, 0);
        // The adapter: the one the game draws on while it runs, else the one with the most video memory.
        Process game = null;
        try {
          var found = Process.GetProcessesByName(gameName);
          for (int i = 0; i < found.Length; i++) { if (i == 0) game = found[0]; else found[i].Dispose(); } // the others' handles go at once
        } catch { }
        Dictionary<string, double> mine = game != null ? EngineLoad(engines, game.Id) : null;
        Adapter gpu = null;
        foreach (var a in adapters) {
          if (mine != null && mine.ContainsKey(a.Luid)) { gpu = a; break; }
          if (gpu == null || a.Vram > gpu.Vram) gpu = a;
        }
        var b = new StringBuilder("{");
        b.Append("\"cpu\":").Append(Num(One("cpu").HasValue ? (double?)Math.Min(100, One("cpu").Value) : null));
        if (gpu != null) {
          double util; all.TryGetValue(gpu.Luid, out util);
          b.Append(",\"gpu\":{\"name\":").Append(Str(gpu.Name)).Append(",\"util\":").Append(Num(engines.Count > 0 ? (double?)util : null))
            .Append(",\"vramUsed\":").Append(Num(amem.Count > 0 ? (double?)SumFor(amem, null, gpu.Luid) : null))
            .Append(",\"vramTotal\":").Append(Num(gpu.Vram > 0 ? (double?)gpu.Vram : null)).Append('}');
        }
        double rx = 0, tx = 0;
        foreach (var e in Values("rx")) if (!Virtual(e.Key)) rx += e.Value;
        foreach (var e in Values("tx")) if (!Virtual(e.Key)) tx += e.Value;
        b.Append(",\"disk\":{\"r\":").Append(Num(One("dr"))).Append(",\"w\":").Append(Num(One("dw"))).Append('}');
        b.Append(",\"net\":{\"rx\":").Append(Num(rx)).Append(",\"tx\":").Append(Num(tx)).Append('}');
        if (game != null) {
          try {
            var now = DateTime.UtcNow;
            var cpu = game.TotalProcessorTime;
            IoCounters io; bool haveIo = GetProcessIoCounters(game.Handle, out io);
            double? cpuPct = null, ioR = null, ioW = null;
            if (game.Id == gamePid && gameAt != DateTime.MinValue) {
              double secs = (now - gameAt).TotalSeconds;
              if (secs > 0) {
                cpuPct = Math.Min(100, Math.Max(0, (cpu - gameCpu).TotalSeconds / secs / cpus * 100));
                if (haveIo) { ioR = Math.Max(0, (io.ReadBytes - gameIo.ReadBytes) / secs); ioW = Math.Max(0, (io.WriteBytes - gameIo.WriteBytes) / secs); }
              }
            }
            gamePid = game.Id; gameCpu = cpu; gameAt = now; if (haveIo) gameIo = io;
            double gutil = 0;
            if (mine != null && gpu != null) mine.TryGetValue(gpu.Luid, out gutil);
            long start = 0; try { start = (long)(game.StartTime.ToUniversalTime() - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; } catch { }
            b.Append(",\"game\":{\"pid\":").Append(game.Id).Append(",\"start\":").Append(start)
              .Append(",\"cpu\":").Append(Num(cpuPct))
              .Append(",\"mem\":").Append(Num(One("gws") ?? WorkingSet(game)))
              .Append(",\"gpu\":").Append(Num(engines.Count > 0 ? (double?)gutil : null))
              .Append(",\"vram\":").Append(Num(pmem.Count > 0 ? (double?)SumFor(pmem, "pid_" + game.Id + "_", null) : null))
              .Append(",\"ioR\":").Append(Num(ioR)).Append(",\"ioW\":").Append(Num(ioW)).Append('}');
          } catch { gamePid = 0; }
          game.Dispose(); // its handle is not kept from one reading to the next
        } else gamePid = 0;
        b.Append('}');
        Console.Out.WriteLine(b.ToString());
        Console.Out.Flush();
      }
    }

    // Task Manager's Memory column is the private working set (the counter above); this, if it is not there.
    static double? WorkingSet(Process p) {
      try { p.Refresh(); return (double)p.WorkingSet64; } catch { return null; }
    }

    static bool Virtual(string name) {
      string n = (name ?? "").ToLowerInvariant();
      return n.Contains("loopback") || n.Contains("isatap") || n.Contains("teredo") || n.Contains("hyper-v") || n.Contains("vethernet") || n.Contains("vmware") || n.Contains("virtualbox");
    }
  }
}
