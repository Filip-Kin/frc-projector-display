import { exec } from 'child_process';

export interface AudioSink { name: string; description: string; }
export interface AudioState { sink: string; volume: number; muted: boolean; }

// Virtual prefix for card-profile-based outputs not in the current active profile
const PROFILE_PREFIX = 'profile:';

export async function getAudioSinks(): Promise<AudioSink[]> {
  return new Promise((resolve) => {
    exec('pactl list sinks && echo "---CARDS---" && pactl list cards', { env: process.env }, (err, stdout) => {
      if (err) { resolve([]); return; }
      const [sinksRaw, cardsRaw = ''] = stdout.split('---CARDS---');
      const sinks: AudioSink[] = [];

      // Active sinks from current profile
      for (const block of sinksRaw.split(/^Sink #/m).slice(1)) {
        const name = block.match(/\tName:\s*(.+)/)?.[1]?.trim();
        const desc = block.match(/\tDescription:\s*(.+)/)?.[1]?.trim();
        if (name) sinks.push({ name, description: desc ?? name });
      }

      // Look for HDMI profiles that aren't currently active
      const activeHdmi = sinks.some(s => s.name.includes('hdmi'));
      if (!activeHdmi) {
        for (const cardBlock of cardsRaw.split(/^Card #/m).slice(1)) {
          const cardName = cardBlock.match(/\tName:\s*(.+)/)?.[1]?.trim();
          if (!cardName) continue;
          // Use the HDMI+analog profile (keeps analog input) as preferred
          const preferred = 'output:hdmi-stereo+input:analog-stereo';
          if (cardBlock.includes(preferred)) {
            sinks.push({
              name: `${PROFILE_PREFIX}${cardName}:${preferred}`,
              description: 'HDMI / DisplayPort',
            });
            break; // only one HDMI option per card
          }
        }
      }

      resolve(sinks);
    });
  });
}

// Move all active audio streams to the current default sink
async function moveAllStreams(): Promise<void> {
  await new Promise<void>(r => {
    exec(`pactl list short sink-inputs | awk '{print $1}' | xargs -I{} pactl move-sink-input {} @DEFAULT_SINK@ 2>/dev/null; true`,
      { env: process.env }, () => r());
  });
}

// Switch card profile (if needed), set default sink, then move all streams
export async function setAudioOutput(sinkName: string): Promise<void> {
  if (sinkName.startsWith(PROFILE_PREFIX)) {
    const rest = sinkName.slice(PROFILE_PREFIX.length);
    const colonIdx = rest.indexOf(':output:');
    if (colonIdx === -1) return;
    const card = rest.slice(0, colonIdx);
    const profile = rest.slice(colonIdx + 1);
    await new Promise<void>(r => exec(`pactl set-card-profile '${card}' '${profile}'`, { env: process.env }, () => r()));
    await new Promise(r => setTimeout(r, 600));
    const pciId = card.replace('alsa_card.', '');
    const newSink = await new Promise<string>(r => {
      exec(`pactl list short sinks | grep '${pciId}' | head -1 | awk '{print $2}'`, { env: process.env }, (_e, out) => r(out.trim()));
    });
    if (newSink) {
      await new Promise<void>(r => exec(`pactl set-default-sink '${newSink}'`, { env: process.env }, () => r()));
      await moveAllStreams();
    }
  } else {
    const pciId = sinkName.replace('alsa_output.', '').replace(/\.[^.]+$/, '');
    const card = `alsa_card.${pciId}`;
    if (sinkName.includes('analog')) {
      await new Promise<void>(r => exec(`pactl set-card-profile '${card}' 'output:analog-stereo+input:analog-stereo' 2>/dev/null; true`, { env: process.env }, () => r()));
      await new Promise(r => setTimeout(r, 400));
    }
    await new Promise<void>(r => exec(`pactl set-default-sink '${sinkName}'`, { env: process.env }, () => r()));
    await moveAllStreams();
  }
}

export function getAudioState(): Promise<AudioState> {
  return new Promise((resolve) => {
    exec('pactl info; pactl get-sink-volume @DEFAULT_SINK@; pactl get-sink-mute @DEFAULT_SINK@',
      { env: process.env }, (err, stdout) => {
        if (err) { resolve({ sink: '', volume: 100, muted: false }); return; }
        const sink = stdout.match(/Default Sink:\s*(.+)/)?.[1]?.trim() ?? '';
        const vol = stdout.match(/(\d+)%/);
        resolve({ sink, volume: vol ? parseInt(vol[1]) : 100, muted: /Mute:\s*yes/i.test(stdout) });
      });
  });
}
