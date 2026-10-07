#!/usr/bin/env python3
import json, re, subprocess

def avahi_browse(svc):
    try:
        r = subprocess.run(['avahi-browse', '-t', '-r', svc],
                           capture_output=True, text=True, timeout=5)
    except Exception:
        return []
    results = []
    current_name = None; addr = None
    for line in r.stdout.split('\n'):
        m = re.match(r'^=\s+\S+\s+\S+\s+(.+?)\s{2,}' + re.escape(svc), line)
        if m:
            current_name = m.group(1).strip(); addr = None; continue
        if current_name:
            am = re.match(r'\s+address\s*=\s*\[(.+?)\]', line)
            pm = re.match(r'\s+port\s*=\s*\[(\d+)\]', line)
            if am: addr = am.group(1)
            if pm and addr: results.append((current_name, addr, pm.group(1))); current_name = None
    return results

sources = []
seen = set()

for name, _a, _p in avahi_browse('_ndi._tcp'):
    if name not in seen:
        seen.add(name)
        sources.append({'label': f'NDI: {name}', 'value': name})

for name, addr, port in avahi_browse('_omt._tcp'):
    if ':' in addr: continue  # IPv6: omt://fe80::...:port does not parse; the IPv4 record is used
    key = f'{addr}:{port}'
    if key not in seen:
        seen.add(key)
        sources.append({'label': f'OMT: {name}', 'value': f'omt://{addr}:{port}'})

# omtx: OMT with H.264/HEVC (github.com/Filip-Kin/omtx), its own service type
for name, addr, port in avahi_browse('_omtx._tcp'):
    if ':' in addr: continue
    key = f'omtx {addr}:{port}'
    if key not in seen:
        seen.add(key)
        sources.append({'label': f'omtx: {name}', 'value': f'omtx://{addr}:{port}'})

print(json.dumps(sources))
