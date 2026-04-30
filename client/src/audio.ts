import { exec } from 'child_process';

export interface AudioSink { name: string; description: string; }
export interface AudioState { sink: string; volume: number; muted: boolean; }

export function getAudioSinks(): Promise<AudioSink[]> {
  return new Promise((resolve) => {
    exec('pactl list sinks', { env: process.env }, (err, stdout) => {
      if (err) { resolve([]); return; }
      const sinks: AudioSink[] = [];
      for (const block of stdout.split(/^Sink #/m).slice(1)) {
        const name = block.match(/\tName:\s*(.+)/)?.[1]?.trim();
        const desc = block.match(/\tDescription:\s*(.+)/)?.[1]?.trim();
        if (name) sinks.push({ name, description: desc ?? name });
      }
      resolve(sinks);
    });
  });
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
