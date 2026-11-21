/** Tiny hash router: #/, #/play/:id, #/edit/:id, #/drill, #/tuner */
import { useEffect, useState } from 'react';

export type Route =
  | { name: 'library' }
  | { name: 'play'; id: string }
  | { name: 'edit'; id: string }
  | { name: 'new' }
  | { name: 'drill'; chords?: string[] }
  | { name: 'tuner' };

export function parseHash(hash: string): Route {
  const [, a, b] = hash.replace(/^#/, '').split('/');
  const arg = b ? decodeURIComponent(b) : '';
  switch (a) {
    case 'play': return arg ? { name: 'play', id: arg } : { name: 'library' };
    case 'edit': return arg ? { name: 'edit', id: arg } : { name: 'library' };
    case 'new': return { name: 'new' };
    case 'drill': return { name: 'drill', chords: arg ? arg.split(',') : undefined };
    case 'tuner': return { name: 'tuner' };
    default: return { name: 'library' };
  }
}

export function href(r: Route): string {
  switch (r.name) {
    case 'play': return `#/play/${encodeURIComponent(r.id)}`;
    case 'edit': return `#/edit/${encodeURIComponent(r.id)}`;
    case 'new': return '#/new';
    case 'drill': return r.chords?.length ? `#/drill/${encodeURIComponent(r.chords.join(','))}` : '#/drill';
    case 'tuner': return '#/tuner';
    default: return '#/';
  }
}

export const go = (r: Route) => { window.location.hash = href(r); };

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
