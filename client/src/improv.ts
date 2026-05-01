// Improv Wi-Fi BLE provisioning server.
// Spec: https://www.improv-wifi.com/ble/
//
// We register a GATT application with BlueZ over D-Bus. BlueZ handles all the
// HCI/L2CAP/ATT plumbing; we just expose the right characteristics and react
// to writes on the RPC command characteristic.
//
// Why D-Bus and not noble/bleno: those libraries grab raw HCI and fight with
// bluetoothd. The D-Bus path is the supported one on BlueZ ≥ 5.50.

import * as dbus from 'dbus-next';

const { Interface, ACCESS_READ } = dbus.interface;
type Variant<T = any> = dbus.Variant<T>;
const Variant = dbus.Variant;

// ── UUIDs ─────────────────────────────────────────────────────────────────────
// Per https://www.improv-wifi.com/ble/ — these UUIDs are part of the spec and
// must match exactly or the SDK on the phone won't find/use the right chars.
const SERVICE_UUID  = '00467768-6228-2272-4663-277478268000';
const STATE_UUID    = '00467768-6228-2272-4663-277478268001';
const ERROR_UUID    = '00467768-6228-2272-4663-277478268002';
const RPC_CMD_UUID  = '00467768-6228-2272-4663-277478268003';
const RPC_RES_UUID  = '00467768-6228-2272-4663-277478268004';
const CAP_UUID      = '00467768-6228-2272-4663-277478268005';
// 16-bit Service Data UUID — the spec REQUIRES this in advertisement data
// (alongside the 128-bit service UUID). Android Web Bluetooth in particular
// relies on this for matching the device against the Improv filter.
const SERVICE_DATA_UUID_SHORT = '4677';

// ── Improv constants ──────────────────────────────────────────────────────────
const STATE_AUTHORIZED   = 0x02;
const STATE_PROVISIONING = 0x03;
const STATE_PROVISIONED  = 0x04;

const ERROR_NONE          = 0x00;
const ERROR_INVALID_RPC   = 0x01;
const ERROR_UNKNOWN_CMD   = 0x02;
const ERROR_UNABLE_CONNECT = 0x03;

const CMD_SEND_WIFI = 0x01;
const CMD_IDENTIFY  = 0x02;

// ── D-Bus paths ───────────────────────────────────────────────────────────────
const ROOT_PATH    = '/com/frc_display/improv';
const SERVICE_PATH = `${ROOT_PATH}/service0`;
const CAP_PATH     = `${SERVICE_PATH}/char0`;
const STATE_PATH   = `${SERVICE_PATH}/char1`;
const ERROR_PATH   = `${SERVICE_PATH}/char2`;
const RPC_CMD_PATH = `${SERVICE_PATH}/char3`;
const RPC_RES_PATH = `${SERVICE_PATH}/char4`;
const ADV_PATH     = `${ROOT_PATH}/advertisement`;
const HCI_PATH     = '/org/bluez/hci0';

// ── GATT Service ──────────────────────────────────────────────────────────────
class GattService extends Interface {
  UUID    = SERVICE_UUID;
  Primary = true;
  constructor() { super('org.bluez.GattService1'); }
}
GattService.configureMembers({
  properties: {
    UUID:    { signature: 's', access: ACCESS_READ },
    Primary: { signature: 'b', access: ACCESS_READ },
  },
  methods: {},
  signals: {},
});

// ── Characteristic base ───────────────────────────────────────────────────────
// Shared shape: UUID, Service path, Flags, Value, Notifying.
// Read/Write/StartNotify/StopNotify forward to subclass hooks.
abstract class GattChar extends Interface {
  abstract UUID: string;
  abstract Flags: string[];
  Service = SERVICE_PATH;
  Value: Buffer = Buffer.alloc(0);
  Notifying = false;
  constructor() { super('org.bluez.GattCharacteristic1'); }

  protected onRead(): Buffer { return this.Value; }
  protected onWrite(_value: Buffer): void { /* override */ }

  ReadValue(_options: { [k: string]: Variant }): Buffer {
    return this.onRead();
  }
  WriteValue(value: Buffer, _options: { [k: string]: Variant }): void {
    this.onWrite(Buffer.from(value));
  }
  StartNotify(): void { this.Notifying = true; }
  StopNotify():  void { this.Notifying = false; }

  // Push a new value to subscribed clients via PropertiesChanged.
  notifyValue(value: Buffer) {
    this.Value = value;
    if (!this.Notifying) return;
    // The bus may have been torn down by a parallel stopImprov() before we
    // got to deliver this notification; emitPropertiesChanged would crash
    // the daemon on a disconnected bus. Swallow the failure since the
    // characteristic is going away anyway.
    try { Interface.emitPropertiesChanged(this, { Value: value }, []); }
    catch (e: any) { console.log(`[improv] notify suppressed (bus closed?): ${e?.message ?? e}`); }
  }
}

const CHAR_CONFIG = {
  properties: {
    UUID:      { signature: 's',  access: ACCESS_READ },
    Service:   { signature: 'o',  access: ACCESS_READ },
    Flags:     { signature: 'as', access: ACCESS_READ },
    Value:     { signature: 'ay', access: ACCESS_READ },
    Notifying: { signature: 'b',  access: ACCESS_READ },
  },
  methods: {
    ReadValue:   { inSignature: 'a{sv}', outSignature: 'ay' },
    WriteValue:  { inSignature: 'aya{sv}', outSignature: '' },
    StartNotify: { inSignature: '', outSignature: '' },
    StopNotify:  { inSignature: '', outSignature: '' },
  },
  signals: {},
};

class CapabilitiesChar extends GattChar {
  UUID  = CAP_UUID;
  Flags = ['read'];
  // bit 0 = supports identify command. We don't visually identify, but accept
  // the RPC and no-op so the spec contract is satisfied.
  Value = Buffer.from([0x01]);
}
CapabilitiesChar.configureMembers(CHAR_CONFIG);

class StateChar extends GattChar {
  UUID  = STATE_UUID;
  // Per spec: Read, Write, Notify. Write is unused by the SDK but flagged
  // for protocol completeness; our onWrite no-ops.
  Flags = ['read', 'write', 'notify'];
  Value = Buffer.from([STATE_AUTHORIZED]);
}
StateChar.configureMembers(CHAR_CONFIG);

class ErrorChar extends GattChar {
  UUID  = ERROR_UUID;
  Flags = ['read', 'write', 'notify'];
  Value = Buffer.from([ERROR_NONE]);
}
ErrorChar.configureMembers(CHAR_CONFIG);

class RpcResultChar extends GattChar {
  UUID  = RPC_RES_UUID;
  Flags = ['read', 'notify'];
}
RpcResultChar.configureMembers(CHAR_CONFIG);

class RpcCommandChar extends GattChar {
  UUID  = RPC_CMD_UUID;
  Flags = ['write'];
  private cb: (cmd: number, data: Buffer) => void;
  constructor(cb: (cmd: number, data: Buffer) => void) {
    super(); // GattChar passes the interface name
    this.cb = cb;
  }
  protected onWrite(value: Buffer): void {
    // RPC packet: [cmd][len][data...][checksum]. Checksum = sum of all preceding bytes mod 256.
    if (value.length < 3) {
      this.cb(0xFF, Buffer.alloc(0)); return;
    }
    const cmd = value[0];
    const len = value[1];
    if (value.length !== 3 + len) {
      this.cb(0xFE, Buffer.alloc(0)); return;
    }
    const checksum = value[2 + len];
    let sum = 0;
    for (let i = 0; i < 2 + len; i++) sum = (sum + value[i]) & 0xFF;
    if (sum !== checksum) {
      this.cb(0xFE, Buffer.alloc(0)); return;
    }
    this.cb(cmd, value.slice(2, 2 + len));
  }
}
RpcCommandChar.configureMembers(CHAR_CONFIG);

// ── ObjectManager root ────────────────────────────────────────────────────────
// BlueZ requires us to expose org.freedesktop.DBus.ObjectManager at the root
// of our GATT app; it walks GetManagedObjects() to discover services + chars.
class ObjectManagerRoot extends Interface {
  // Filled in by the orchestrator below
  managed: { [path: string]: { [iface: string]: { [prop: string]: Variant } } } = {};

  constructor() { super('org.freedesktop.DBus.ObjectManager'); }

  GetManagedObjects() {
    return this.managed;
  }
}
ObjectManagerRoot.configureMembers({
  properties: {},
  methods: {
    GetManagedObjects: { inSignature: '', outSignature: 'a{oa{sa{sv}}}' },
  },
  signals: {
    InterfacesAdded:   { signature: 'oa{sa{sv}}' },
    InterfacesRemoved: { signature: 'oas' },
  },
});

// ── Advertisement object (LEAdvertisement1) ───────────────────────────────────
class Advertisement extends Interface {
  Type = 'peripheral';
  ServiceUUIDs = [SERVICE_UUID];
  LocalName: string;
  Includes: string[] = [];
  Discoverable = true;
  // Advertise every ~100ms. BlueZ's default of 1280ms is way too slow for
  // Web Bluetooth picker dialogs to reliably see us.
  MinInterval = 100;
  MaxInterval = 250;
  // Per Improv spec, the advertisement MUST include service data with 16-bit
  // UUID 4677, payload [state, capabilities, 0, 0, 0, 0]. Many Android stacks
  // match against this 16-bit UUID for filtering; without it the device may
  // not appear in the Web Bluetooth picker even though the 128-bit service
  // UUID is also in the advertisement.
  ServiceData: { [uuid: string]: Variant };

  constructor(localName: string, state: number, capabilities: number) {
    super('org.bluez.LEAdvertisement1');
    this.LocalName = localName;
    this.ServiceData = {
      [SERVICE_DATA_UUID_SHORT]: new Variant('ay', Buffer.from([state, capabilities, 0, 0, 0, 0])),
    };
  }
  Release(): void { /* no-op; bluez calls this on unregister */ }
}
Advertisement.configureMembers({
  properties: {
    Type:         { signature: 's',     access: ACCESS_READ },
    ServiceUUIDs: { signature: 'as',    access: ACCESS_READ },
    LocalName:    { signature: 's',     access: ACCESS_READ },
    Includes:     { signature: 'as',    access: ACCESS_READ },
    Discoverable: { signature: 'b',     access: ACCESS_READ },
    MinInterval:  { signature: 'u',     access: ACCESS_READ },
    MaxInterval:  { signature: 'u',     access: ACCESS_READ },
    ServiceData:  { signature: 'a{sv}', access: ACCESS_READ },
  },
  methods: {
    Release: { inSignature: '', outSignature: '' },
  },
  signals: {},
});

// ── Helpers for GetManagedObjects payload ─────────────────────────────────────
function charProps(c: GattChar): { [k: string]: Variant } {
  return {
    UUID:      new Variant('s', c.UUID),
    Service:   new Variant('o', c.Service),
    Flags:     new Variant('as', c.Flags),
    Notifying: new Variant('b', c.Notifying),
    Value:     new Variant('ay', c.Value),
  };
}
function serviceProps(s: GattService): { [k: string]: Variant } {
  return {
    UUID:    new Variant('s', s.UUID),
    Primary: new Variant('b', s.Primary),
  };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────
type ImprovStartOptions = {
  localName: string;
  redirectUrl: string;
  // Hand credentials to the daemon. Caller is responsible for tearing down AP,
  // calling connectWifi, restoring AP on failure, etc. Resolve with success.
  onCredentials: (ssid: string, password: string) => Promise<{ success: boolean }>;
  // Fired when the client sends the IDENTIFY RPC. Caller should briefly
  // signal which physical device this is (flash the screen, blink an LED).
  onIdentify?: () => Promise<void> | void;
  // Fired after the PROVISIONED state has been pushed to the client (post a
  // short delay so the BLE notify actually leaves the controller). Caller
  // should run post-connect logic + tear down provisioning.
  onProvisionedDone?: () => Promise<void> | void;
};

let bus: dbus.MessageBus | null = null;
let registered = false;
let advertised = false;
let chars: { state: StateChar; error: ErrorChar; rpcRes: RpcResultChar; rpcCmd: RpcCommandChar; cap: CapabilitiesChar } | null = null;

function buildResultPacket(strings: string[]): Buffer {
  // Result format: [cmd_id][total_data_len][string_count][s1_len][s1_bytes]...[checksum]
  const inner: number[] = [strings.length];
  for (const s of strings) {
    const b = Buffer.from(s, 'utf-8');
    inner.push(b.length);
    for (const x of b) inner.push(x);
  }
  const cmd = CMD_SEND_WIFI;
  const len = inner.length;
  const all: number[] = [cmd, len, ...inner];
  let sum = 0; for (const x of all) sum = (sum + x) & 0xFF;
  all.push(sum);
  return Buffer.from(all);
}

export async function startImprov(opts: ImprovStartOptions): Promise<void> {
  if (registered) return;
  console.log(`[improv] starting BLE GATT server (advertising as "${opts.localName}")`);
  bus = dbus.systemBus();

  const svc    = new GattService();
  const cap    = new CapabilitiesChar();
  const state  = new StateChar();
  const error  = new ErrorChar();
  const rpcRes = new RpcResultChar();
  const rpcCmd = new RpcCommandChar(async (cmd, data) => {
    if (cmd === CMD_IDENTIFY) {
      console.log('[improv] identify requested');
      if (opts.onIdentify) {
        try { await opts.onIdentify(); }
        catch (e: any) { console.error(`[improv] onIdentify threw: ${e?.message}`); }
      }
      return;
    }
    if (cmd === CMD_SEND_WIFI) {
      let ssid = '', password = '';
      try {
        if (data.length < 2) throw new Error('truncated payload');
        const ssidLen = data[0];
        if (1 + ssidLen + 1 > data.length) throw new Error('bad ssid len');
        ssid = data.slice(1, 1 + ssidLen).toString('utf-8');
        const passLen = data[1 + ssidLen];
        if (2 + ssidLen + passLen !== data.length) throw new Error('bad pass len');
        password = data.slice(2 + ssidLen, 2 + ssidLen + passLen).toString('utf-8');
      } catch (e: any) {
        console.error(`[improv] RPC parse error: ${e?.message ?? e}`);
        error.notifyValue(Buffer.from([ERROR_INVALID_RPC]));
        return;
      }
      console.log(`[improv] credentials received: SSID=${ssid} (pass len=${password.length})`);
      error.notifyValue(Buffer.from([ERROR_NONE]));
      state.notifyValue(Buffer.from([STATE_PROVISIONING]));
      let result: { success: boolean } = { success: false };
      try { result = await opts.onCredentials(ssid, password); }
      catch (e: any) { console.error(`[improv] onCredentials threw: ${e?.message ?? e}`); }
      if (!result.success) {
        error.notifyValue(Buffer.from([ERROR_UNABLE_CONNECT]));
        state.notifyValue(Buffer.from([STATE_AUTHORIZED]));
        return;
      }
      rpcRes.notifyValue(buildResultPacket([opts.redirectUrl]));
      state.notifyValue(Buffer.from([STATE_PROVISIONED]));
      // Brief delay so the controller actually transmits the PROVISIONED notify
      // before we tear down the GATT app & advertisement.
      await new Promise(r => setTimeout(r, 600));
      if (opts.onProvisionedDone) {
        try { await opts.onProvisionedDone(); }
        catch (e: any) { console.error(`[improv] onProvisionedDone threw: ${e?.message}`); }
      }
      return;
    }
    error.notifyValue(Buffer.from([ERROR_UNKNOWN_CMD]));
  });

  chars = { state, error, rpcRes, rpcCmd, cap };

  // Export every object on the bus
  bus.export(SERVICE_PATH, svc);
  bus.export(CAP_PATH,     cap);
  bus.export(STATE_PATH,   state);
  bus.export(ERROR_PATH,   error);
  bus.export(RPC_CMD_PATH, rpcCmd);
  bus.export(RPC_RES_PATH, rpcRes);

  // ObjectManager at root — required by BlueZ for GATT app discovery
  const om = new ObjectManagerRoot();
  om.managed = {
    [SERVICE_PATH]: { 'org.bluez.GattService1':        serviceProps(svc) },
    [CAP_PATH]:     { 'org.bluez.GattCharacteristic1': charProps(cap) },
    [STATE_PATH]:   { 'org.bluez.GattCharacteristic1': charProps(state) },
    [ERROR_PATH]:   { 'org.bluez.GattCharacteristic1': charProps(error) },
    [RPC_CMD_PATH]: { 'org.bluez.GattCharacteristic1': charProps(rpcCmd) },
    [RPC_RES_PATH]: { 'org.bluez.GattCharacteristic1': charProps(rpcRes) },
  };
  bus.export(ROOT_PATH, om);

  // Register with BlueZ
  const bluezObj = await bus.getProxyObject('org.bluez', HCI_PATH);
  const gattMgr  = bluezObj.getInterface('org.bluez.GattManager1');
  await gattMgr.RegisterApplication(ROOT_PATH, {});
  registered = true;
  console.log('[improv] GATT application registered');

  // Advertisement (with mandatory service data)
  const adv = new Advertisement(opts.localName, STATE_AUTHORIZED, /* capabilities */ 0x01);
  bus.export(ADV_PATH, adv);
  const advMgr = bluezObj.getInterface('org.bluez.LEAdvertisingManager1');
  await advMgr.RegisterAdvertisement(ADV_PATH, {});
  advertised = true;
  console.log('[improv] BLE advertisement registered');

  // Make sure the controller is powered on and advertising-capable
  const adapterIfaces = await bus.getProxyObject('org.bluez', HCI_PATH);
  const adapterProps = adapterIfaces.getInterface('org.freedesktop.DBus.Properties');
  await adapterProps.Set('org.bluez.Adapter1', 'Powered', new Variant('b', true)).catch(() => {});
}

export async function stopImprov(): Promise<void> {
  if (!bus) return;
  console.log('[improv] stopping BLE GATT server');
  try {
    const bluezObj = await bus.getProxyObject('org.bluez', HCI_PATH);
    if (advertised) {
      const advMgr = bluezObj.getInterface('org.bluez.LEAdvertisingManager1');
      await advMgr.UnregisterAdvertisement(ADV_PATH).catch(() => {});
      advertised = false;
    }
    if (registered) {
      const gattMgr = bluezObj.getInterface('org.bluez.GattManager1');
      await gattMgr.UnregisterApplication(ROOT_PATH).catch(() => {});
      registered = false;
    }
  } catch (e: any) {
    console.error(`[improv] stop error: ${e?.message ?? e}`);
  }
  // Drop bus connection — fresh one next start
  try { bus.disconnect(); } catch {}
  bus = null;
  chars = null;
}

export function isImprovRunning(): boolean {
  return registered;
}
