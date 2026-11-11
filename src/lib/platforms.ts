// Every platform the app can publish to or pull content from.

export type PlatformId =
  | 'tiktok' | 'instagram' | 'youtube' | 'facebook' | 'linkedin' | 'x' | 'pinterest'
  | 'threads' | 'bluesky' | 'snapchat' | 'gbp' | 'amazon' | 'dropbox' | 'gdrive' | 'podcast';

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
  { id: 'tiktok', name: 'TikTok', color: '#111111', glyph: 'T', limit: 2200, source: true, destination: true, formats: ['Video'], hint: 'Short vertical videos, up to 10 minutes.' },
  { id: 'instagram', name: 'Instagram', color: '#d6249f', glyph: 'IG', limit: 2200, source: true, destination: true, formats: ['Reel', 'Post', 'Story'], hint: 'Reels up to 90 seconds work best.' },
  { id: 'youtube', name: 'YouTube', color: '#f61c0d', glyph: '▶', limit: 5000, source: true, destination: true, formats: ['Short', 'Video'], hint: 'Shorts under 60 seconds, titles up to 100 characters.' },
  { id: 'facebook', name: 'Facebook', color: '#385c8e', glyph: 'f', limit: 63206, source: true, destination: true, formats: ['Reel', 'Video', 'Post'], hint: 'Pages and Reels.' },
  { id: 'linkedin', name: 'LinkedIn', color: '#0a66c2', glyph: 'in', limit: 3000, source: false, destination: true, formats: ['Video', 'Post'], hint: 'Personal profiles and company pages.' },
  { id: 'x', name: 'X (Twitter)', color: '#000000', glyph: 'X', limit: 280, source: false, destination: true, formats: ['Video', 'Post'], hint: '280 characters per post.' },
  { id: 'pinterest', name: 'Pinterest', color: '#e60023', glyph: 'P', limit: 500, source: false, destination: true, formats: ['Video Pin', 'Pin'], hint: 'Video pins need a board.' },
  { id: 'threads', name: 'Threads', color: '#1c1c1c', glyph: '@', limit: 500, source: false, destination: true, formats: ['Post'], hint: '500 characters per post.' },
  { id: 'bluesky', name: 'Bluesky', color: '#1185fe', glyph: 'B', limit: 300, source: false, destination: true, formats: ['Post'], hint: '300 characters per post.' },
  { id: 'snapchat', name: 'Snapchat', color: '#f7d600', glyph: 'S', limit: 160, source: false, destination: true, formats: ['Spotlight'], hint: 'Spotlight videos, 160 character captions.' },
  { id: 'gbp', name: 'Google Business', color: '#4285f4', glyph: 'G', limit: 1500, source: false, destination: true, formats: ['Update'], hint: 'Updates on your business profile.' },
  { id: 'amazon', name: 'Amazon', color: '#ff9900', glyph: 'a', limit: 1000, source: false, destination: true, formats: ['Influencer video'], hint: 'Amazon Influencer storefront videos.' },
  { id: 'dropbox', name: 'Dropbox', color: '#0061ff', glyph: 'D', limit: 0, source: true, destination: false, formats: [], hint: 'New files in a folder become posts.' },
  { id: 'gdrive', name: 'Google Drive', color: '#0f9d58', glyph: 'G', limit: 0, source: true, destination: false, formats: [], hint: 'New files in a folder become posts.' },
  { id: 'podcast', name: 'Podcast (RSS)', color: '#8940fa', glyph: '◉', limit: 0, source: true, destination: false, formats: [], hint: 'New episodes from your RSS feed.' },
];

export const platform = (id: PlatformId): Platform => PLATFORMS.find((p) => p.id === id)!;

export function badge(id: PlatformId, size = 28): string {
  const p = platform(id);
  const dark = id === 'snapchat';
  const fs = Math.round(size * (p.glyph.length > 1 ? 0.38 : 0.5));
  return `<span class="pbadge" style="width:${size}px;height:${size}px;background:${p.color};color:${dark ? '#000' : '#fff'};font-size:${fs}px" title="${p.name}">${p.glyph}</span>`;
}
