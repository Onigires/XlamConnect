'use strict';
const { execFile } = require('child_process');

const run = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout: 20000 }, (err, stdout, stderr) => (err ? reject(new Error((stderr || stdout || err.message).toString().trim())) : resolve(stdout.toString())));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const maskOf = (prefix) => [24, 16, 8, 0].map((s) => ((0xffffffff << (32 - prefix)) >>> s) & 255).join('.');

/** assign the virtual IP, MTU, mark the network private and let room members reach this PC */
async function configureAdapter({ name, ip, prefix, mtu, firewall, log }) {
  // the interface appears a moment after WintunCreateAdapter returns
  let lastErr;
  for (let i = 0; i < 20; i++) {
    try { await run('netsh', ['interface', 'ip', 'set', 'address', `name=${name}`, 'static', ip, maskOf(prefix)]); lastErr = null; break; }
    catch (e) { lastErr = e; await sleep(500); }
  }
  if (lastErr) throw new Error(`Could not set the adapter IP address: ${lastErr.message}`);
  await run('netsh', ['interface', 'ipv4', 'set', 'subinterface', name, `mtu=${mtu}`, 'store=active']).catch((e) => log('mtu:', e.message));
  await run('netsh', ['interface', 'ipv4', 'set', 'interface', name, 'metric=5']).catch(() => {});
  const ps = (cmd) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd]);
  // best-effort: private profile so file sharing / discovery work
  (async () => {
    for (let i = 0; i < 10; i++) {
      try { await ps(`Set-NetConnectionProfile -InterfaceAlias '${name}' -NetworkCategory Private -ErrorAction Stop`); return; } catch { await sleep(1000); }
    }
  })();
  if (firewall) {
    // inbound from the virtual adapter only (bound to the interface, so it can't be spoofed from the LAN)
    await ps(`Remove-NetFirewallRule -DisplayName 'Xlam Connect (virtual network)' -ErrorAction SilentlyContinue; ` +
      `New-NetFirewallRule -DisplayName 'Xlam Connect (virtual network)' -Direction Inbound -Action Allow -Profile Any -InterfaceAlias '${name}' | Out-Null`).catch((e) => log('firewall:', e.message));
  }
}

async function isAdmin() {
  if (process.platform !== 'win32') return true;
  try { await run('fltmc', []); return true; } catch { return false; }
}

module.exports = { configureAdapter, isAdmin, maskOf };
