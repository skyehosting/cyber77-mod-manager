'use strict';
const fs = require('fs');
const { execFile } = require('child_process');

/*
 * Letting friends' apps through this PC's firewall (Group Mods). Asked once, when groups are turned
 * on; removed when they are turned off.
 *
 * Windows: one admin prompt (UAC) runs a small PowerShell script that removes our old rule and any
 * block rule Windows made for this app (a cancelled "allow access?" prompt leaves one, and a block
 * rule beats an allow rule), then adds one inbound allow rule for this program on this TCP port, on
 * private and public networks (Windows calls many home networks public). Checking needs no admin.
 * Linux: there is no common prompt; ufw or firewalld are detected and their command is shown, or run
 * through pkexec (the desktop's password prompt). Nothing is changed without the user's click.
 * Research and sources: notes/group-mods.md.
 */

const RULE = 'Edgerunners Mod Manager - Group Mods';
// Windows PowerShell by its full path: a powershell.exe in the current folder or earlier on PATH is never run.
const POWERSHELL = require('path').join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const UAC_CANCELLED = 1223;

const run = (cmd, args, opts = {}) => new Promise(resolve => {
  execFile(cmd, args, { windowsHide: true, timeout: 120e3, ...opts }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});
// PowerShell treats the curly single quotes as quotes too: each one is doubled like '.
const psQuote = s => `'${String(s).replace(/['‘’‚‛]/g, q => q + q)}'`;
const validPort = p => Number.isInteger(p) && p >= 1024 && p <= 65535;

/** Windows: is our rule there, for this program and port? { present, matches } (no admin needed). */
async function windowsCheck(port, exe) {
  const script = `$r = Get-NetFirewallRule -DisplayName ${psQuote(RULE)} -ErrorAction SilentlyContinue
if (-not $r) { '{}'; exit 0 }
$p = @($r | Get-NetFirewallPortFilter | ForEach-Object { $_.LocalPort })
$a = @($r | Get-NetFirewallApplicationFilter | ForEach-Object { $_.Program })
@{ ports = $p; programs = $a; enabled = @($r | ForEach-Object { [string]$_.Enabled }) } | ConvertTo-Json -Compress`;
  const r = await run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { cwd: require('os').tmpdir() });
  let d = {};
  try { d = JSON.parse(r.stdout.trim() || '{}'); } catch { return { present: false, matches: false, unknown: true }; }
  if (!d.ports) return { present: false, matches: false };
  const arr = v => (Array.isArray(v) ? v : [v]).map(String);
  const matches = arr(d.ports).includes(String(port)) && arr(d.programs).some(p => p.toLowerCase() === exe.toLowerCase()) && arr(d.enabled).includes('True');
  return { present: true, matches };
}

/**
 * Windows: add (or remove) our rule through one admin prompt. The commands go to the elevated
 * PowerShell inside its own command line (-EncodedCommand): no script file that anything else could
 * change while the prompt waits. Resolves { ok } or { ok: false, cancelled } or { ok: false, error }.
 */
async function windowsApply({ port, exe, remove = false }) {
  if (!remove && !validPort(port)) throw new Error('The port must be a number from 1024 to 65535.');
  const lines = [
    '$ErrorActionPreference = "Stop"',
    `Get-NetFirewallRule -DisplayName ${psQuote(RULE)} -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
  ];
  if (!remove) {
    lines.push(
      // Block rules Windows made for this program (a cancelled prompt): they would win over ours.
      `Get-NetFirewallApplicationFilter -Program ${psQuote(exe)} -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } | Remove-NetFirewallRule`,
      `New-NetFirewallRule -DisplayName ${psQuote(RULE)} -Description 'Lets your Group Mods friends connect (Edgerunners Mod Manager). Removed when groups are turned off.' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Program ${psQuote(exe)} -Profile Private,Public | Out-Null`,
    );
  }
  lines.push('exit 0');
  const encoded = Buffer.from(lines.join('\n'), 'utf16le').toString('base64');
  const outer = `try { $p = Start-Process -FilePath ${psQuote(POWERSHELL)} -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'; exit $p.ExitCode } catch { exit ${UAC_CANCELLED} }`;
  const r = await run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', outer], { cwd: require('os').tmpdir() });
  if (r.code === 0) return { ok: true };
  if (r.code === UAC_CANCELLED) return { ok: false, cancelled: true };
  return { ok: false, error: `Windows did not change the firewall (code ${r.code}).` };
}

/** Linux: which firewall is on, and the command that opens the port. { kind, command } or { kind: '' }. */
/** The first of these that exists (pkexec must not look programs up on the user's PATH). */
const which = (...paths) => paths.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || '';

async function linuxCheck(port) {
  if (!validPort(port)) return { kind: '' };
  const ufw = which('/usr/sbin/ufw', '/sbin/ufw', '/usr/bin/ufw');
  const fwc = which('/usr/bin/firewall-cmd', '/bin/firewall-cmd', '/usr/sbin/firewall-cmd');
  const sh = which('/bin/sh', '/usr/bin/sh');
  try {
    if (ufw && /^\s*ENABLED\s*=\s*yes/mi.test(fs.readFileSync('/etc/ufw/ufw.conf', 'utf8'))) return { kind: 'ufw', command: `sudo ufw allow ${port}/tcp`, run: [ufw, 'allow', `${port}/tcp`], undo: [ufw, 'delete', 'allow', `${port}/tcp`] };
  } catch { /* no ufw */ }
  const fw = fwc ? await run(fwc, ['--state'], { timeout: 5e3 }) : { code: 1 };
  if (fw.code === 0 && /running/.test(fw.stdout) && sh) {
    // firewalld can say whether the port is open already (ufw can't without root).
    const q = await run(fwc, [`--query-port=${port}/tcp`], { timeout: 5e3 });
    return { kind: 'firewalld', open: q.code === 0, command: `sudo firewall-cmd --add-port=${port}/tcp --permanent && sudo firewall-cmd --reload`, run: [sh, '-c', `${fwc} --add-port=${port}/tcp --permanent && ${fwc} --reload`], undo: [sh, '-c', `${fwc} --remove-port=${port}/tcp --permanent && ${fwc} --reload`] };
  }
  return { kind: '' };
}

/** Linux: run the firewall command through pkexec (the desktop's own password prompt). */
async function linuxApply(port, { remove = false } = {}) {
  const c = await linuxCheck(port);
  if (!c.kind) return { ok: true, none: true };
  const pkexec = which('/usr/bin/pkexec', '/bin/pkexec');
  if (!pkexec) return { ok: false, error: 'pkexec is not installed: run the command yourself.', command: c.command };
  const r = await run(pkexec, remove ? c.undo : c.run);
  if (r.code === 0) return { ok: true };
  if (r.code === 126 || r.code === 127) return { ok: false, cancelled: true, command: c.command };
  return { ok: false, error: `The firewall command failed (code ${r.code}).`, command: c.command };
}

/** The state for the Groups settings: { platform, ok, kind?, command? }. */
async function check(port, exe) {
  if (process.platform === 'win32') {
    const r = await windowsCheck(port, exe);
    return { platform: 'win32', ok: r.matches, present: r.present, unknown: !!r.unknown };
  }
  const c = await linuxCheck(port);
  // ufw: whether the port is open can't be read without root, so it is "not confirmed" (unknown).
  return { platform: process.platform, ok: !c.kind || c.open === true, unknown: c.kind === 'ufw', present: c.open === true, kind: c.kind, command: c.command || '' };
}

async function allow({ port, exe }) {
  return process.platform === 'win32' ? windowsApply({ port, exe }) : linuxApply(port);
}
async function disallow({ port, exe }) {
  return process.platform === 'win32' ? windowsApply({ port, exe, remove: true }) : linuxApply(port, { remove: true });
}

module.exports = { check, allow, disallow, RULE, psQuote, validPort };
