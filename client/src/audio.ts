import { exec } from 'child_process';

export interface AudioSink { name: string; description: string; profile?: string; card?: string; }
export interface AudioState { sink: string; volume: number; muted: boolean; }

// Returns active sinks plus available HDMI outputs from inactive card profiles
export function getAudioSinks(): Promise<AudioSink[]> {
  return new Promise((resolve) => {
    exec('pactl list sinks && echo "---CARDS---" && pactl list cards', { env: process.env }, (err, stdout) => {
      if (err) { resolve([]); return; }
      const [sinksRaw, cardsRaw] = stdout.split('---CARDS---');
      const sinks: AudioSink[] = [];

      // Active sinks
      for (const block of sinksRaw.split(/^Sink #/m).slice(1)) {
        const name = block.match(/\tName:\s*(.+)/)?.[1]?.trim();
        const desc = block.match(/\tDescription:\s*(.+)/)?.[1]?.trim();
        if (name) sinks.push({ name, description: desc ?? name });
      }

      // Add HDMI outputs from inactive profiles
      if (cardsRaw) {
        for (const cardBlock of cardsRaw.split(/^Card #/m).slice(1)) {
          const cardName = cardBlock.match(/\tName:\s*(.+)/)?.[1]?.trim();
          const activeProfile = cardBlock.match(/Active Profile:\s*(.+)/)?.[1]?.trim();
          if (!cardName) continue;

          // Find HDMI profiles not currently active
          const profileMatches = [...cardBlock.matchAll(/\t\t(.+?):\s.*\(sinks: \d+.*\)/g)];
          for (const pm of profileMatches) {
            const profName = pm[1].trim();
            if (!profName.includes('hdmi') && !profName.includes('HDMI')) continue;
            if (profName === activeProfile) continue;
            // Virtual sink entry for this profile
            const label = profName.includes('hdmi-stereo') ? 'HDMI / DisplayPort' : `HDMI (${profName})`;
            const virtualName = `profile:${cardName}:${profName}`;
            if (!sinks.some(s => s.name === virtualName)) {
              sinks.push({ name: virtualName, description: label, profile: profName, card: cardName });
            }
          }
        }
      }

      resolve(sinks);
    });
  });
}

// Switch card profile if needed, then set default sink
export async function setAudioOutput(sinkName: string): Promise<void> {
  if (sinkName.startsWith('profile:')) {
    // Format: profile:card_name:profile_name
    const parts = sinkName.split(':');
    const card = parts.slice(1, -1).join(':');
    const profile = parts[parts.length - 1];
    await new Promise<void>((resolve) => {
      exec(`pactl set-card-profile '${card}' '${profile}'`, { env: process.env }, () => resolve());
    });
    // Wait a moment for the new sink to appear
    await new Promise(r => setTimeout(r, 500));
    // Set default sink to the first sink now active on this card
    await new Promise<void>((resolve) => {
      exec(`pactl list short sinks | grep "${card.split('.')[0]}" | head -1 | cut -f2`, { env: process.env }, (_err, out) => {
        const newSink = out.trim();
        if (newSink) exec(`pactl set-default-sink '${newSink}'`, { env: process.env }, () => resolve());
        else resolve();
      });
    });
  } else {
    await new Promise<void>((resolve) => {
      exec(`pactl set-default-sink '${sinkName}'`, { env: process.env }, () => resolve());
    });
  }
}

export function getAudioState(): Promise<AudioState> {
  return new Promise((resolve) => {
    exec('pactl info; pactl get-sink-volume @DEFAULT_SINK@; pactl get-sink-mute @DEFAULT_SINK@',
      { env: process.env }, (err, stdout) => {
        if (err) { resolve({ sink: '', volume: 100, muted: false }); return; }
        const sink = stdout.match(/Default Sink:\s*(.+)/)?.[1]?.trim() ?? '';
        const vol  = stdout.match(/(\d+)%/);
        resolve({ sink, volume: vol ? parseInt(vol[1]) : 100, muted: /Mute:\s*yes/i.test(stdout) });
      });
  });
}
