import express from 'express';
import { createServer } from 'http';
import QRCode from 'qrcode';
import path from 'path';
import { exec } from 'child_process';
import { state } from './state.js';
import { cdpNavigate } from './cdp.js';
import { stopAp, startAp, connectWifi, scanWifi, checkInternet } from './wifi.js';
import { getEthernetInterface, getEthernetStatus, applyDhcp, applyCustomStaticIp } from './network.js';
import { setHome, stopNdi, stopVnc } from './modes.js';

export const LOCAL_PORT = parseInt(process.env.LOCAL_PORT ?? '3000', 10);
export const AP_IP = '192.168.4.1';

let PIN = '';
let AP_SSID = '';
let CONTROL_URL = '';
let VERSION = '';
let SERVER_BASE = '';

export function initServer(pin: string, apSsid: string, controlUrl: string, version: string, serverBase: string) {
  PIN = pin; AP_SSID = apSsid; CONTROL_URL = controlUrl; VERSION = version; SERVER_BASE = serverBase;
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Captive portal: when in AP mode, redirect any non-local request to /setup.
// This makes the OS show the "Sign in to network" notification on phones.
app.use((req, res, next) => {
  if (!state.apMode) return next();
  const host = (req.get('host') ?? '').split(':')[0];
  if (host === AP_IP || host === 'localhost' || host === '127.0.0.1') {
    return next();
  }
  return res.redirect(`http://${AP_IP}:${LOCAL_PORT}/setup`);
});

app.get('/', async (_req, res) => {
  if (state.apMode) {
    const qr = await QRCode.toDataURL(`WIFI:T:nopass;S:${AP_SSID};;`, { width: 320, margin: 2, color: { dark: '#000', light: '#fff' } });
    res.send(buildApPage(qr));
  } else {
    const qr = await QRCode.toDataURL(CONTROL_URL, { width: 320, margin: 2, color: { dark: '#000', light: '#fff' } });
    res.send(buildQrPage(qr));
  }
});

app.get('/youtube', (req, res) => {
  const id = req.query.v ?? '';
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#000;overflow:hidden}iframe{position:fixed;top:0;left:0;width:100%;height:100%;border:0}</style></head><body><iframe src="https://www.youtube.com/embed/${id}?autoplay=1&rel=0" allow="autoplay;fullscreen" allowfullscreen></iframe></body></html>`);
});

app.get('/connecting', (_req, res) => res.send(buildConnectingPage()));
app.get('/no-connection', (_req, res) => res.send(buildNoConnectionPage()));

// Live debug state — reachable from any device on the network for diagnosis
app.get('/api/debug', async (_req, res) => {
  const { exec: execAsync } = await import('child_process');
  const route = await new Promise<string>(r => execAsync('ip route show default', (_e, out) => r(out.trim())));
  const links = await new Promise<string>(r => execAsync('ip -br link', (_e, out) => r(out.trim())));
  res.json({
    version: VERSION,
    pin: PIN,
    apMode: state.apMode,
    apIface: state.apIface,
    currentMode: state.currentMode,
    wsState: state.serverWs?.readyState,    // 0=connecting 1=open 2=closing 3=closed
    wsEverConnected: state.wsEverConnected,
    ndiProcessAlive: state.ndiProcess !== null,
    defaultRoute: route || '(none)',
    links,
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/wifi-scan', async (_req, res) => res.json(await scanWifi().catch(() => [])));

app.get('/api/eth-status', async (_req, res) => {
  const iface = await getEthernetInterface();
  if (!iface) { res.json({ iface: null }); return; }
  const status = await getEthernetStatus(iface);
  res.json(status);
});

app.post('/api/eth-config', async (req, res) => {
  const { mode, ip, prefix, gateway } = req.body as { mode: string; ip?: string; prefix?: string; gateway?: string };
  const iface = await getEthernetInterface();
  if (!iface) { res.status(400).json({ error: 'No ethernet interface found' }); return; }
  try {
    if (mode === 'dhcp') {
      await applyDhcp(iface);
      res.json({ ok: true, message: 'DHCP enabled — reconnecting…' });
    } else {
      if (!ip) { res.status(400).json({ error: 'IP required for static mode' }); return; }
      await applyCustomStaticIp(iface, ip, prefix ?? '24', gateway ?? '');
      res.json({ ok: true, message: `Static IP ${ip} applied` });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/internet-status', async (_req, res) => {
  const result = await checkInternet();
  if (result.online && !state.postConnectInProgress) {
    res.json({ online: true, status: 'proceeding' });
    runPostConnect();
  } else {
    res.json(result);
  }
});

app.get('/setup', async (_req, res) => {
  const networks = await scanWifi().catch(() => []);
  res.send(buildSetupPage(networks));
});

app.post('/setup', async (req, res) => {
  const { ssid, password } = req.body as { ssid?: string; password?: string };
  if (!ssid) { res.status(400).json({ error: 'SSID required' }); return; }

  if (state.apIface) {
    await stopAp(state.apIface).catch(() => {});
    state.apMode = false;
  }

  try {
    await connectWifi(ssid, password ?? '');
  } catch {
    if (state.apIface) {
      state.apMode = true;
      await startAp(PIN, state.apIface).catch(() => {});
      await cdpNavigate(`http://localhost:${LOCAL_PORT}/`).catch(() => {});
    }
    return res.json({ status: 'error', message: 'Could not connect — check SSID and password' });
  }

  let result = { online: false, portalUrl: null as string | null };
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    result = await checkInternet();
    if (result.online || result.portalUrl) break;
  }

  if (result.portalUrl) {
    await cdpNavigate(result.portalUrl).catch(() => {});
    return res.json({ status: 'captive_portal', portalUrl: result.portalUrl, pin: PIN });
  }

  if (!result.online) {
    if (state.apIface) {
      state.apMode = true;
      await startAp(PIN, state.apIface).catch(() => {});
      await cdpNavigate(`http://localhost:${LOCAL_PORT}/`).catch(() => {});
    }
    return res.json({ status: 'error', message: 'Connected to WiFi but no internet — check password or try again' });
  }

  res.json({ status: 'online' });
  runPostConnect();
});

export async function runPostConnect() {
  if (state.postConnectInProgress) return;
  state.postConnectInProgress = true;
  console.log('[wifi] connected — checking for updates');

  let updated = false;
  try {
    const checkScript = path.join(import.meta.dir, '../check-update.sh');
    const stdout: string = await new Promise(r => {
      exec(`/bin/bash "${checkScript}"`, { timeout: 120000, env: process.env }, (_, out) => r(out ?? ''));
    });
    console.log('[update]', stdout.trim());
    updated = stdout.includes('[update] done');
  } catch (e: any) { console.error('[update]', e.message); }

  if (updated) {
    console.log('[update] restarting display session');
    exec('sudo systemctl restart lightdm', () => {});
  } else {
    await cdpNavigate(`http://localhost:${LOCAL_PORT}/`).catch(() => {});
    state.postConnectInProgress = false;
  }
}

export async function enterApMode() {
  console.log('[ap] === enterApMode called ===');
  console.log(`[ap] currentMode=${state.currentMode} ndi=${!!state.ndiProcess} apMode=${state.apMode}`);

  // Stop any active media — ndi-play covers Chromium fullscreen so clear it first
  await stopNdi();
  stopVnc();
  console.log('[ap] media stopped');

  const { getWifiInterface } = await import('./wifi.js');
  const iface = await getWifiInterface();
  console.log(`[ap] wifi interface: ${iface ?? '(none)'}`);

  if (!iface) {
    console.log('[ap] NO WIFI ADAPTER — showing no-connection screen');
    await cdpNavigate(`http://localhost:${LOCAL_PORT}/no-connection`).catch(() => {});
    return;
  }

  console.log(`[ap] starting hotspot ${AP_SSID} on ${iface}`);
  try {
    await startAp(PIN, iface);
    state.apMode = true;
    state.apIface = iface;
    console.log('[ap] hotspot ACTIVE — navigating to AP page');
    await cdpNavigate(`http://localhost:${LOCAL_PORT}/`);
    console.log('[ap] navigation complete');
  } catch (err: any) {
    console.error(`[ap] FAILED to start: ${err.message}`);
    await cdpNavigate(`http://localhost:${LOCAL_PORT}/no-connection`).catch(() => {});
  }
}

export const localServer = createServer(app);

// ── HTML builders ─────────────────────────────────────────────────────────────

function buildQrPage(qrDataUrl: string) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>FRC Display</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#111;color:#f0f0f0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;gap:28px}h1{font-size:2.4rem;font-weight:700;letter-spacing:.02em}.qr-box{background:#fff;padding:16px;border-radius:16px;box-shadow:0 0 60px #4af4}.qr-box img{display:block;width:280px;height:280px}.pin-label{font-size:1rem;color:#aaa;margin-bottom:4px}.pin{font-size:3rem;font-weight:800;letter-spacing:.25em;color:#4af}.url{font-size:.85rem;color:#555;word-break:break-all;text-align:center;max-width:480px}.version{font-size:1rem;color:#777;position:fixed;bottom:12px;right:16px}</style>
</head><body>
<h1>Configure Display</h1>
<div class="qr-box"><img src="${qrDataUrl}" alt="QR"></div>
<div><div class="pin-label">PIN</div><div class="pin">${PIN}</div></div>
<div class="url">${SERVER_BASE.replace(/^https?:\/\//, '')}</div>
<div class="version">v${VERSION}</div>
</body></html>`;
}

function buildApPage(qrDataUrl: string) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>WiFi Setup</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#111;color:#f0f0f0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;gap:24px}h1{font-size:2rem;font-weight:700;color:#fa0}.qr-box{background:#fff;padding:16px;border-radius:16px;box-shadow:0 0 60px #fa04}.qr-box img{display:block;width:260px;height:260px}.ssid{font-size:1.6rem;font-weight:700;letter-spacing:.06em;color:#fa0}.hint{font-size:.9rem;color:#888;text-align:center}.url{font-size:.8rem;color:#444;margin-top:4px}.version{font-size:1rem;color:#777;position:fixed;bottom:12px;right:16px}</style>
</head><body>
<h1>WiFi Setup</h1>
<div class="qr-box"><img src="${qrDataUrl}" alt="WiFi QR"></div>
<div class="ssid">${AP_SSID}</div>
<div><div class="hint">Scan to connect, then configure WiFi</div><div class="url">Or open http://${AP_IP}:${LOCAL_PORT}/setup</div></div>
<div class="version">v${VERSION}</div>
</body></html>`;
}

function signalBars(s: number) {
  return s >= 70 ? '▂▄▆█' : s >= 50 ? '▂▄▆░' : s >= 30 ? '▂▄░░' : '▂░░░';
}

function buildSetupPage(networks: { ssid: string; signal: number; secured: boolean }[]) {
  const netRows = networks.map(n => `<div class="net-row" onclick="selectNetwork('${n.ssid.replace(/'/g,"\\'")}')"><span class="bars">${signalBars(n.signal)}</span><span class="net-name">${n.ssid.replace(/</g,'&lt;')}</span>${n.secured ? '<span>🔒</span>' : ''}</div>`).join('');
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>WiFi Setup</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#111;color:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:16px;min-height:100vh}h1{font-size:1.3rem;font-weight:700;color:#fa0;margin-bottom:16px}.section-title{font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;color:#666;margin:16px 0 8px}.net-list{background:#1c1c1c;border-radius:10px;overflow:hidden;margin-bottom:4px}.net-row{display:flex;align-items:center;gap:10px;padding:12px 14px;cursor:pointer;border-bottom:1px solid #222}.net-row:last-child{border-bottom:none}.net-row:active{background:#2a2a2a}.bars{font-size:1rem;color:#4af;min-width:32px}.net-name{flex:1;font-size:.95rem}input{width:100%;background:#1c1c1c;border:1px solid #333;border-radius:8px;color:#f0f0f0;padding:12px 14px;font-size:1rem;outline:none;margin-top:4px}input:focus{border-color:#fa0}label{font-size:.8rem;color:#888;display:block;margin-top:14px}.pw-row{position:relative}.pw-row input{padding-right:48px}.pw-toggle{position:absolute;right:12px;top:50%;transform:translateY(-50%);background:none;border:none;color:#666;cursor:pointer;font-size:.85rem;padding:4px}button.connect{width:100%;background:#fa0;color:#000;border:none;border-radius:8px;padding:14px;font-size:1rem;font-weight:700;cursor:pointer;margin-top:20px}button.connect:active{opacity:.8}#status{margin-top:16px;padding:12px 14px;border-radius:10px;font-size:.9rem;display:none}#status.error{background:#2a0a0a;color:#f66;display:block}#status.info{background:#1a1a2a;color:#aaf;display:block}#status.success{background:#0a2a0a;color:#6f6;display:block}.vnc-link{display:block;margin-top:10px;color:#4af;font-size:.85rem}.spinner{display:inline-block;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style>
</head><body>
<h1>WiFi Setup</h1>
<div class="section-title">Nearby Networks</div>
<div class="net-list" id="net-list">${netRows || '<div style="padding:12px 14px;color:#555;font-size:.9rem">No networks found</div>'}</div>
<button style="font-size:.8rem;background:none;border:none;color:#4af;cursor:pointer;padding:6px 0;display:block" onclick="refreshScan()">↻ Refresh scan</button>
<div class="section-title">Network</div>
<input type="text" id="ssid" placeholder="Network name">
<label>Password <span style="color:#555">(leave blank for open networks)</span></label>
<div class="pw-row"><input type="password" id="password" placeholder="Password"><button class="pw-toggle" onclick="togglePw()" type="button">Show</button></div>
<button class="connect" onclick="doConnect()">Connect</button>
<div id="status"></div>
<hr style="border:none;border-top:1px solid #222;margin:24px 0">
<div class="section-title">Ethernet (AV Network / No DHCP)</div>
<div id="eth-status" style="font-size:.82rem;color:#555;margin-bottom:10px">Checking…</div>
<div style="display:flex;gap:8px;margin-bottom:10px">
  <button id="btn-dhcp" onclick="setEthMode('dhcp')" style="flex:1;background:#252525;color:#ccc;padding:9px;font-size:.85rem">DHCP</button>
  <button id="btn-static" onclick="setEthMode('static')" style="flex:1;background:#252525;color:#ccc;padding:9px;font-size:.85rem">Static IP</button>
</div>
<div id="eth-static-fields" style="display:none">
  <label>IP Address</label><input type="text" id="eth-ip" placeholder="192.168.25.xxx">
  <label>Prefix length</label><input type="text" id="eth-prefix" placeholder="24" value="24">
  <label>Gateway <span style="color:#555">(leave blank if none)</span></label><input type="text" id="eth-gw" placeholder="192.168.25.1">
  <button class="connect" style="background:#4af;margin-top:12px" onclick="applyEth()">Apply Static IP</button>
</div>
<div id="eth-status2"></div>
<script>
function selectNetwork(ssid){document.getElementById('ssid').value=ssid;document.getElementById('password').focus()}
function togglePw(){const i=document.getElementById('password');const b=event.target;i.type=i.type==='password'?'text':'password';b.textContent=i.type==='password'?'Show':'Hide'}
async function refreshScan(){const l=document.getElementById('net-list');l.innerHTML='<div style="padding:12px 14px;color:#555">Scanning…</div>';const r=await fetch('/api/wifi-scan').then(r=>r.json()).catch(()=>[]);if(!r.length){l.innerHTML='<div style="padding:12px 14px;color:#555">No networks found</div>';return}l.innerHTML=r.map(n=>\`<div class="net-row" onclick="selectNetwork('\${n.ssid.replace(/'/g,"\\\\'")}')"><span class="bars">\${n.signal>=70?'▂▄▆█':n.signal>=50?'▂▄▆░':n.signal>=30?'▂▄░░':'▂░░░'}</span><span class="net-name">\${n.ssid.replace(/</g,'&lt;')}</span>\${n.secured?'<span>🔒</span>':''}</div>\`).join('')}
function setStatus(cls,msg){const e=document.getElementById('status');e.className=cls;e.innerHTML=msg}
async function doConnect(){const ssid=document.getElementById('ssid').value.trim();if(!ssid){setStatus('error','Enter a network name');return}const password=document.getElementById('password').value;setStatus('info','<span class="spinner">⟳</span> Connecting to <b>'+ssid+'</b>…');document.querySelector('.connect').disabled=true;try{const r=await fetch('/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ssid,password})}).then(r=>r.json());if(r.status==='online'||r.status==='connected'){setStatus('success','✓ Connected! Display restarting…')}else if(r.status==='captive_portal'){setStatus('info','⚠ Venue requires sign-in. Use <a class="vnc-link" href="/vnc/'+r.pin+'" target="_blank">Web VNC</a> to sign in, then <button onclick="pollInternet()" style="margin-top:8px;background:#fa0;color:#000;border:none;border-radius:6px;padding:8px 16px;cursor:pointer">I signed in — continue</button>')}else{setStatus('error',r.message||'Connection failed');document.querySelector('.connect').disabled=false}}catch(e){setStatus('error','Request failed — try again');document.querySelector('.connect').disabled=false}}
async function pollInternet(){setStatus('info','<span class="spinner">⟳</span> Checking internet…');for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,2000));const r=await fetch('/api/internet-status').then(r=>r.json()).catch(()=>({}));if(r.online||r.status==='proceeding'){setStatus('success','✓ Connected!');return}}setStatus('error','Still no internet. Try again.')}
let ethMode='dhcp';
function setEthMode(m){ethMode=m;document.getElementById('btn-dhcp').style.background=m==='dhcp'?'#333':'#252525';document.getElementById('btn-static').style.background=m==='static'?'#333':'#252525';document.getElementById('eth-static-fields').style.display=m==='static'?'block':'none'}
async function applyEth(){const ip=document.getElementById('eth-ip').value.trim();const prefix=document.getElementById('eth-prefix').value.trim()||'24';const gw=document.getElementById('eth-gw').value.trim();if(!ip){document.getElementById('eth-status2').innerHTML='<span style="color:#f66">Enter an IP address</span>';return}const r=await fetch('/api/eth-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'static',ip,prefix,gateway:gw})}).then(r=>r.json()).catch(()=>({error:'Request failed'}));document.getElementById('eth-status2').innerHTML=r.ok?'<span style="color:#6f6">✓ '+r.message+'</span>':'<span style="color:#f66">'+r.error+'</span>'}
async function loadEthStatus(){const s=await fetch('/api/eth-status').then(r=>r.json()).catch(()=>({}));if(!s.iface){document.getElementById('eth-status').textContent='No ethernet adapter detected';return}const ip=s.ip||'No IP';const note=s.isLinkLocal?' (DHCP failed — link-local)':s.hasRoutableIp?' (connected)':' (no IP)';document.getElementById('eth-status').textContent=s.iface+': '+ip+note;if(s.ip)document.getElementById('eth-ip').value=s.ip}
loadEthStatus();setEthMode('dhcp');
</script>
</body></html>`;
}

function buildConnectingPage() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>FRC Display</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#111;color:#f0f0f0;display:flex;flex-direction:column;align-items:center;
    justify-content:center;height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;gap:24px}
  .spinner{width:56px;height:56px;border:5px solid #222;border-top-color:#4af;border-radius:50%;
    animation:spin 0.9s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  h1{font-size:1.6rem;font-weight:600;color:#888}
  .version{font-size:1rem;color:#777;position:fixed;bottom:12px;right:16px}
</style></head>
<body>
  <div class="spinner"></div>
  <h1>Connecting to server…</h1>
  <div class="version">v${VERSION}</div>
</body></html>`;
}

function buildNoConnectionPage() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>No Connection</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#1a0505;color:#f0f0f0;display:flex;flex-direction:column;align-items:center;
    justify-content:center;height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;gap:24px;text-align:center}
  .icon{font-size:5rem}
  h1{font-size:2.2rem;font-weight:800;color:#f44;letter-spacing:.02em}
  p{font-size:1.1rem;color:#aaa;max-width:520px;line-height:1.6}
  .url{font-size:.85rem;color:#555;margin-top:8px}
  .version{font-size:1rem;color:#666;position:fixed;bottom:12px;right:16px}
</style></head>
<body>
  <div class="icon">⚠️</div>
  <h1>No Connection</h1>
  <p>This display cannot reach the control server.<br>
  Content on screen is <strong style="color:#f66">not live</strong>.</p>
  <p>Connect this device to a network with internet access,<br>
  or reboot it — a WiFi setup screen will appear after 20 seconds.</p>
  <div class="url">${SERVER_BASE}</div>
  <div class="version">v${VERSION}</div>
</body></html>`;
}
