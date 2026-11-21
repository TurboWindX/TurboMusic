/**
 * USB / Bluetooth MIDI keyboards via the Web MIDI API (Chrome, Edge, Opera).
 *
 * Listens to every connected input, tracks held keys and the sustain pedal,
 * and handles hot-plugging. Needs a secure page: http://localhost or https
 * (a Cloudflare tunnel is fine; a plain http://192.168.x.x LAN address is not).
 */
import { useSyncExternalStore } from 'react';

export type MidiStatus = 'idle' | 'asking' | 'ready' | 'denied' | 'unsupported' | 'insecure';

export interface MidiNoteEvent {
  type: 'on' | 'off';
  midi: number;
  velocity: number; // 0..1
  /** Keyboard name, or 'screen' for the on-screen keys. */
  device?: string;
}

export interface MidiSnapshot {
  status: MidiStatus;
  devices: string[];
  error?: string;
}

type NoteListener = (e: MidiNoteEvent) => void;
type PedalListener = (down: boolean) => void;

class MidiInput {
  private access: MIDIAccess | null = null;
  private snapshot: MidiSnapshot = { status: 'idle', devices: [] };
  private subs = new Set<() => void>();
  private noteSubs = new Set<NoteListener>();
  private pedalSubs = new Set<PedalListener>();
  readonly held = new Set<number>();
  pedal = false;

  get supported() { return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator; }

  getSnapshot = () => this.snapshot;
  subscribe = (fn: () => void) => { this.subs.add(fn); return () => this.subs.delete(fn); };

  onNote(fn: NoteListener) { this.noteSubs.add(fn); return () => { this.noteSubs.delete(fn); }; }
  onPedal(fn: PedalListener) { this.pedalSubs.add(fn); return () => { this.pedalSubs.delete(fn); }; }

  private set(patch: Partial<MidiSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.subs.forEach((fn) => fn());
  }

  /** Ask for MIDI access (Chrome shows a permission prompt the first time). Safe to call repeatedly. */
  async connect(): Promise<void> {
    if (this.access || this.snapshot.status === 'asking') return;
    if (!window.isSecureContext) return this.set({ status: 'insecure' });
    if (!this.supported) return this.set({ status: 'unsupported' });
    this.set({ status: 'asking' });
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      return this.set({ status: 'denied', error: e instanceof Error ? e.message : String(e) });
    }
    this.access.onstatechange = () => this.attach();
    this.attach();
  }

  /** (Re)bind every input; called on connect and whenever a device is plugged in or out. */
  private attach() {
    if (!this.access) return;
    const names: string[] = [];
    this.access.inputs.forEach((input) => {
      if (input.state !== 'connected') return;
      const name = input.name || 'MIDI keyboard';
      names.push(name);
      input.onmidimessage = (ev) => this.handle(ev.data, name);
    });
    if (!names.length) { this.held.clear(); this.pedal = false; }
    this.set({ status: 'ready', devices: names });
  }

  private handle(data: Uint8Array | null, device: string) {
    if (!data || data.length < 2) return;
    const cmd = data[0] & 0xf0;
    const d1 = data[1];
    const d2 = data[2] ?? 0;
    if (cmd === 0x90 && d2 > 0) this.emit({ type: 'on', midi: d1, velocity: d2 / 127, device });
    else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) this.emit({ type: 'off', midi: d1, velocity: 0, device });
    else if (cmd === 0xb0 && d1 === 64) {
      const down = d2 >= 64;
      if (down !== this.pedal) { this.pedal = down; this.pedalSubs.forEach((fn) => fn(down)); }
    }
  }

  /** Also used by the on-screen keyboard (mouse/touch), so it behaves like a real key. */
  emit(e: MidiNoteEvent) {
    if (e.type === 'on') this.held.add(e.midi);
    else this.held.delete(e.midi);
    this.noteSubs.forEach((fn) => fn(e));
  }
}

export const midi = new MidiInput();

export function useMidi(): MidiSnapshot {
  return useSyncExternalStore(midi.subscribe, midi.getSnapshot);
}

// Debug/automation handle: lets scripts (and the browser console) press keys without hardware,
// e.g. __turboMidi.emit({ type: 'on', midi: 60, velocity: 0.8 }).
(globalThis as { __turboMidi?: MidiInput }).__turboMidi = midi;
