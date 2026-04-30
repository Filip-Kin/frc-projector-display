const { exec, execFile } = require('child_process');

async function getWifiInterface() {
  return new Promise((resolve) => {
    exec("nmcli -t -f DEVICE,TYPE device status 2>/dev/null | grep ':wifi' | head -1 | cut -d: -f1",
      (err, stdout) => resolve(stdout.trim() || null));
  });
}

async function hasDefaultRoute() {
  return new Promise((resolve) => {
    exec('ip route show default', (err, stdout) => resolve(!err && stdout.trim().length > 0));
  });
}

async function startAp(pin, iface) {
  return new Promise((resolve, reject) => {
    execFile('sudo', ['/usr/local/bin/frc-ap-start', pin, iface], { timeout: 15000 }, (err, _out, stderr) => {
      if (err) { console.error('[ap] start error:', stderr); reject(err); } else resolve();
    });
  });
}

async function stopAp(iface) {
  return new Promise((resolve) => {
    execFile('sudo', ['/usr/local/bin/frc-ap-stop', iface], { timeout: 10000 }, () => resolve());
  });
}

async function connectWifi(ssid, password) {
  return new Promise((resolve, reject) => {
    execFile('sudo', ['/usr/local/bin/frc-wifi-connect', ssid, password || ''],
      { timeout: 30000 }, (err, _out, stderr) => {
        if (err) { console.error('[wifi] connect error:', stderr); reject(err); } else resolve();
      });
  });
}

async function scanWifi() {
  return new Promise((resolve) => {
    exec('nmcli -t -f SSID,SIGNAL,SECURITY dev wifi list 2>/dev/null', (err, stdout) => {
      if (err || !stdout.trim()) { resolve([]); return; }
      const networks = [];
      const seen = new Set();
      for (const line of stdout.trim().split('\n')) {
        // nmcli terse mode escapes : in values as \:  — split on unescaped colons
        const parts = line.split(/(?<!\\):/);
        if (parts.length < 3) continue;
        // SSID is everything except last 2 fields (SIGNAL, SECURITY)
        const security = parts.pop().replace(/\\:/g, ':').trim();
        const signal = parseInt(parts.pop()) || 0;
        const ssid = parts.join(':').replace(/\\:/g, ':').trim();
        if (!ssid || seen.has(ssid)) continue;
        seen.add(ssid);
        networks.push({ ssid, signal, secured: security !== '--' && security !== '' });
      }
      networks.sort((a, b) => b.signal - a.signal);
      resolve(networks);
    });
  });
}

// Returns {online: bool, portalUrl: string|null}
async function checkInternet() {
  return new Promise((resolve) => {
    // Follow redirects (-L), get headers only (-sI), quick timeout
    exec('curl -sLI --max-time 8 http://connectivitycheck.gstatic.com/generate_204 2>/dev/null', (err, stdout) => {
      if (err || !stdout) { resolve({ online: false, portalUrl: null }); return; }
      // Find last HTTP status code (after all redirects)
      const statuses = [...stdout.matchAll(/HTTP\/\S+\s+(\d+)/g)];
      const lastStatus = statuses.length ? parseInt(statuses[statuses.length - 1][1]) : 0;
      if (lastStatus === 204) {
        resolve({ online: true, portalUrl: null });
      } else {
        // Extract first redirect location as portal URL
        const locMatch = stdout.match(/[Ll]ocation:\s*(\S+)/);
        resolve({ online: false, portalUrl: locMatch ? locMatch[1].trim() : null });
      }
    });
  });
}

module.exports = { getWifiInterface, hasDefaultRoute, startAp, stopAp, connectWifi, scanWifi, checkInternet };
