/**
 * Import a tab page the user picked (Ultimate Guitar) into song fields.
 * Fetched server-side (no CORS in the browser). Only UG hosts are allowed,
 * so this endpoint can't be used to make the server fetch arbitrary URLs.
 */

export interface ImportResult {
  title: string;
  artist: string;
  tab: string;
  chords: string[];
  capo: number;
  tuning: string;
  type: string;
  sourceUrl: string;
}

const ALLOWED_HOST = /(^|\.)ultimate-guitar\.com$/i;

export class ImportError extends Error {}

export function validateImportUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ImportError('That is not a valid link');
  }
  if (url.protocol !== 'https:' || !ALLOWED_HOST.test(url.hostname)) {
    throw new ImportError('Only Ultimate Guitar links (https://…ultimate-guitar.com/tab/…) are supported for now');
  }
  return url;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

/** Turn UG wiki markup ([tab], [ch]X[/ch]) into plain text + chord list. */
export function cleanUgContent(content: string): { text: string; chords: string[] } {
  const chords: string[] = [];
  const text = content
    .replace(/\r\n?/g, '\n')
    .replace(/\[ch\]([^[]*)\[\/ch\]/g, (_, c: string) => {
      chords.push(c.trim());
      return c;
    })
    .replace(/\[\/?tab\]/g, '')
    .replace(/\[\/?[a-z]+\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, chords };
}

export function parseUgPage(html: string, sourceUrl: string): ImportResult {
  const m = /class="js-store"\s+data-content="([^"]*)"/.exec(html);
  if (!m) throw new ImportError('Could not find tab data on that page (the site layout may have changed)');
  let store: any;
  try {
    store = JSON.parse(decodeEntities(m[1]));
  } catch {
    throw new ImportError('Tab data on that page could not be read');
  }
  const data = store?.store?.page?.data ?? store?.page?.data;
  const content: string | undefined = data?.tab_view?.wiki_tab?.content;
  if (!content) throw new ImportError('That page has no text tab (it may be a Pro/official tab, which can’t be imported)');
  const { text, chords } = cleanUgContent(content);
  const meta = data?.tab_view?.meta ?? {};
  return {
    title: String(data?.tab?.song_name ?? 'Imported song'),
    artist: String(data?.tab?.artist_name ?? ''),
    tab: text,
    chords,
    capo: Number(meta?.capo) || 0,
    tuning: String(meta?.tuning?.value ?? meta?.tuning?.name ?? 'E A D G B E'),
    type: String(data?.tab?.type ?? ''),
    sourceUrl,
  };
}

export async function importFromUrl(raw: string): Promise<ImportResult> {
  const url = validateImportUrl(raw);
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
  } catch (e) {
    throw new ImportError(`Couldn’t reach the site: ${(e as Error).message}`);
  }
  const finalHost = new URL(res.url).hostname;
  if (!ALLOWED_HOST.test(finalHost)) throw new ImportError('The link redirected off Ultimate Guitar');
  if (!res.ok) throw new ImportError(`The site answered ${res.status}. Try again in a minute, or paste the tab manually.`);
  return parseUgPage(await res.text(), url.toString());
}
