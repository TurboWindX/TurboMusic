/** Turn dropped/picked files into a SheetImport, whatever the format. */
import { api } from '../api';
import { parseMidi, SheetError } from './midi';
import { parseMusicXmlFile } from './musicxml';
import type { SheetImport } from './sheet';

export { SheetError };

export const SHEET_ACCEPT = '.mid,.midi,.kar,.musicxml,.xml,.mxl,.pdf,.png,.jpg,.jpeg,.webp,.gif';

export type SheetKind = 'midi' | 'musicxml' | 'scan';

export function sheetKind(file: File): SheetKind | null {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  if (['mid', 'midi', 'kar'].includes(ext)) return 'midi';
  if (['musicxml', 'xml', 'mxl'].includes(ext)) return 'musicxml';
  if (['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'scan';
  if (ext === 'mscz' || ext === 'mscx') return null;
  return null;
}

export function unsupportedHint(file: File): string {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'mscz' || ext === 'mscx') return 'MuseScore files: in MuseScore use File → Export → MusicXML (or MIDI), then import that.';
  if (['gp', 'gp5', 'gpx', 'gp4'].includes(ext)) return 'Guitar Pro files: export as MusicXML or MIDI from Guitar Pro / TuxGuitar.';
  return `Can't read .${ext} files. Use MIDI (.mid), MusicXML (.musicxml/.mxl), or a PDF / photo of the sheet.`;
}

/** Parse local files (MIDI / MusicXML). PDFs and photos go through `transcribeScans`. */
export async function parseSheetFile(file: File): Promise<SheetImport> {
  const data = new Uint8Array(await file.arrayBuffer());
  const kind = sheetKind(file);
  // Trust the content over the extension.
  if (data[0] === 0x4d && data[1] === 0x54 && data[2] === 0x68 && data[3] === 0x64) return parseMidi(data, file.name);
  if (kind === 'musicxml' || data[0] === 0x3c || (data[0] === 0x50 && data[1] === 0x4b) || (data[0] === 0xef && data[1] === 0xbb)) {
    return parseMusicXmlFile(data, file.name);
  }
  throw new SheetError(unsupportedHint(file));
}

const MEDIA: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
};

/** Send PDF / photo pages to Claude and wait for the transcription (can take a few minutes). */
export async function transcribeScans(
  files: File[],
  onProgress: (seconds: number) => void,
  signal?: AbortSignal,
): Promise<SheetImport> {
  const payload = await Promise.all(files.map(async (f) => ({
    name: f.name,
    mediaType: MEDIA[f.name.toLowerCase().split('.').pop() ?? ''] ?? f.type,
    data: await toBase64(f),
  })));
  const { id } = await api.transcribeStart(payload);
  for (;;) {
    if (signal?.aborted) throw new SheetError('Cancelled');
    await new Promise((r) => setTimeout(r, 2500));
    const job = await api.transcribeStatus(id);
    onProgress(job.elapsed);
    if (job.status === 'error') throw new SheetError(job.error ?? 'Transcription failed');
    if (job.status === 'done' && job.result) {
      const r = job.result;
      return {
        format: 'Sheet music (read by Claude)',
        title: r.title || files[0].name.replace(/\.[^.]+$/, ''),
        composer: r.composer || undefined,
        bpm: r.bpm,
        beatsPerBar: r.beatsPerBar,
        parts: [{ id: 'piano', name: 'Piano', notes: r.notes, staves: 2, drums: false, pianoLike: true }],
        warnings: [
          'Read from a scan by Claude: check it by ear, mistakes are possible.',
          ...(r.remarks ? [r.remarks] : []),
        ],
      };
    }
  }
}

async function toBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}
