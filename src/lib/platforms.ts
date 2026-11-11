// Every platform the app can publish to or pull content from.

export type PlatformId =
  | 'tiktok' | 'instagram' | 'youtube' | 'facebook'
  | 'snapchat' | 'gbp' | 'amazon' | 'dropbox' | 'gdrive' | 'podcast';

/** Platforms the app no longer offers; accounts of these are removed when the app loads. */
export const RETIRED_PLATFORMS = ['linkedin', 'x', 'pinterest', 'threads', 'bluesky'];

export interface Platform {
  id: PlatformId;
  name: string;
  color: string;
  glyph: string;
  /** Caption limit in characters */
  limit: number;
  /** Can be used as a source of new content */
  source: boolean;
  /** Can receive posts */
  destination: boolean;
  /** Kind of post the platform takes */
  formats: string[];
  hint: string;
}

export const PLATFORMS: Platform[] = [
  { id: 'tiktok', name: 'TikTok', color: '#111111', glyph: 'T', limit: 2200, source: true, destination: true, formats: ['Video'], hint: 'Kurze Hochkant-Videos, bis 10 Minuten.' },
  { id: 'instagram', name: 'Instagram', color: '#d6249f', glyph: 'IG', limit: 2200, source: true, destination: true, formats: ['Reel', 'Post', 'Story'], hint: 'Reels bis 90 Sekunden funktionieren am besten.' },
  { id: 'youtube', name: 'YouTube', color: '#f61c0d', glyph: '▶', limit: 5000, source: true, destination: true, formats: ['Short', 'Video'], hint: 'Shorts bis 3 Minuten, Titel bis 100 Zeichen.' },
  { id: 'facebook', name: 'Facebook', color: '#385c8e', glyph: 'f', limit: 63206, source: true, destination: true, formats: ['Reel', 'Video', 'Post'], hint: 'Seiten und Reels.' },
  { id: 'snapchat', name: 'Snapchat', color: '#f7d600', glyph: 'S', limit: 160, source: false, destination: true, formats: ['Spotlight'], hint: 'Spotlight-Videos, Beschreibung bis 160 Zeichen.' },
  { id: 'gbp', name: 'Google Business', color: '#4285f4', glyph: 'G', limit: 1500, source: false, destination: true, formats: ['Neuigkeit'], hint: 'Neuigkeiten in deinem Unternehmensprofil.' },
  { id: 'amazon', name: 'Amazon', color: '#ff9900', glyph: 'a', limit: 1000, source: false, destination: true, formats: ['Influencer-Video'], hint: 'Videos für deinen Amazon-Influencer-Shop.' },
  { id: 'dropbox', name: 'Dropbox', color: '#0061ff', glyph: 'D', limit: 0, source: true, destination: false, formats: [], hint: 'Neue Dateien in einem Ordner werden zu Posts.' },
  { id: 'gdrive', name: 'Google Drive', color: '#0f9d58', glyph: 'G', limit: 0, source: true, destination: false, formats: [], hint: 'Neue Dateien in einem Ordner werden zu Posts.' },
  { id: 'podcast', name: 'Podcast (RSS)', color: '#8940fa', glyph: '◉', limit: 0, source: true, destination: false, formats: [], hint: 'Neue Folgen aus deinem RSS-Feed.' },
];

const UNKNOWN: Platform = { id: 'tiktok', name: 'Unbekannt', color: '#8a90a0', glyph: '?', limit: 0, source: false, destination: false, formats: [], hint: '' };
export const platform = (id: PlatformId): Platform => PLATFORMS.find((p) => p.id === id) ?? { ...UNKNOWN, id };

export function badge(id: PlatformId, size = 28): string {
  const p = platform(id);
  const dark = id === 'snapchat';
  const fs = Math.round(size * (p.glyph.length > 1 ? 0.38 : 0.5));
  return `<span class="pbadge" style="width:${size}px;height:${size}px;background:${p.color};color:${dark ? '#000' : '#fff'};font-size:${fs}px" title="${p.name}">${p.glyph}</span>`;
}
