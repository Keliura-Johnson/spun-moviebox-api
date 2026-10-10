// src/index.ts
// Spün MovieBox Worker — main entry point.

import {
  fetchWithHostPool,
  PATHS,
  type MBSearchData,
  type MBDetailData,
  type MBSeasonData,
  type MBResourceData,
  type MBResourceItem,
} from './moviebox.js';
import type { SigningEnv } from './signing.js';

// subjectType: 1=movie, 2=tv, 7=shorts — all others filtered out
const ALLOWED_SUBJECT_TYPES = new Set([1, 2, 7]);

function resolveSubjectType(subjectType: number): 'movie' | 'tv' | 'shorts' {
  if (subjectType === 2) return 'tv';
  if (subjectType === 7) return 'shorts';
  return 'movie';
}

export interface Env extends SigningEnv {
  MOVIEBOX_SECRET: string;
  NIGERIA_IP?: string;
}

// ─── Response helpers ─────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

// ─── Auth guard ───────────────────────────────────────────────────────────────

function isAuthorized(_request: Request, _env: Env): boolean {
  return true;
}

// ─── Language name map ────────────────────────────────────────────────────────

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',   fr: 'Français',   ar: 'Arabic',    zh: 'Chinese',
  ru: 'Russian',   pt: 'Português', es: 'Spanish',    de: 'German',
  ja: 'Japanese',  ko: 'Korean',    it: 'Italian',    sw: 'Kiswahili',
  ha: 'Hausa',     ms: 'Malay',     bn: 'Bengali',    ur: 'Urdu',
  pa: 'Punjabi',   fil: 'Filipino', id: 'Indonesian',
};

const RESOLUTIONS = [360, 480, 720, 1080];

async function fetchResourcePack(env: Env, subjectId: string): Promise<MBResourceItem[] | null> {
  const seenResourceIds = new Set<string>();
  const allItems: MBResourceItem[] = [];
  const perPage = 10;

  for (const resolution of RESOLUTIONS) {
    let page = 1;

    while (true) {
      const data = await fetchWithHostPool<MBResourceData>(
        env, PATHS.resource, 'GET', { subjectId, se: 0, ep: 0, resolution, page, perPage }
      );

      if (!data?.list?.length) break;

      for (const item of data.list) {
        if (!seenResourceIds.has(item.resourceId)) {
          seenResourceIds.add(item.resourceId);
          allItems.push(item);
        }
      }

      if (!data.pager?.hasMore) break;

      page++;
      if (page > 100) break;
    }
  }

  if (!allItems.length) return null;

  return allItems.sort((a, b) => b.resolution - a.resolution);
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signMediaProxyTarget(
  expires: number,
  targetUrl: string,
  secret: string,
  filename = ''
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signedPayload = filename
    ? `${expires}\n${targetUrl}\n${filename}`
    : `${expires}\n${targetUrl}`;
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signedPayload)
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sanitizeFilenamePart(value: string, fallback: string): string {
  const normalized = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 100);

  return normalized || fallback;
}

function buildDownloadFilename(title: string, subjectType: number, item: MBResourceItem): string {
  const titlePart = sanitizeFilenamePart(title, 'MovieBox');
  const qualityPart = Number.isFinite(item.resolution) && item.resolution > 0
    ? `${item.resolution}p`
    : 'unknown';
  const episodePart = subjectType === 1
    ? ''
    : `_S${String(item.se).padStart(2, '0')}E${String(item.ep).padStart(2, '0')}`;

  return `${titlePart}_${qualityPart}${episodePart}_bySpün.mp4`;
}

async function proxyMediaUrl(
  resourceLink: string,
  env: Env,
  download = false,
  filename?: string
): Promise<string> {
  const relayBaseUrl = env.RELAY_URL?.trim().replace(/\/+$/, '');
  const relaySecret = env.RELAY_SECRET?.trim();
  let target: URL;
  try {
    target = new URL(resourceLink);
  } catch {
    return resourceLink;
  }

  if (!relayBaseUrl || !relaySecret || target.protocol !== 'https:' || target.hostname.toLowerCase() !== 'bcdn.hakunaymatata.com') {
    return resourceLink;
  }

  const expires = Number.parseInt(target.searchParams.get('t') ?? '', 10);
  if (!Number.isInteger(expires)) return resourceLink;

  const signature = await signMediaProxyTarget(expires, target.toString(), relaySecret, filename);
  const proxy = new URL(`${relayBaseUrl}/media/${base64UrlEncode(target.toString())}`);
  proxy.searchParams.set('e', String(expires));
  proxy.searchParams.set('s', signature);
  if (download) proxy.searchParams.set('download', '1');
  if (filename) proxy.searchParams.set('filename', filename);
  return proxy.toString();
}

async function mapResourceItem(
  item: MBResourceItem,
  env: Env,
  download = false,
  filename?: string
) {
  const sizeMb = item.size
    ? `${Math.round(parseInt(item.size) / (1024 * 1024))} MB`
    : null;

  const captions = (item.extCaptions || []).map((cap) => ({
    language:     cap.lanName || LANGUAGE_NAMES[cap.lan] || cap.lan,
    language_code: cap.lan,
    url:          cap.url,
  }));

  return {
    quality:    `${item.resolution}p`,
    resolution: item.resolution,
    url:        await proxyMediaUrl(item.resourceLink, env, download, filename),
    filename:   filename ?? null,
    format:     'mp4' as const,
    size:       sizeMb,
    codecName:  item.codecName ?? null,
    duration:   item.duration ?? null,
    captions,
    se:         item.se,
    ep:         item.ep,
  };
}

function handleRoot(): Response {
  return json({
    name:        'Spün MovieBox API',
    version:     '1.1.0',
    description: 'Spün MovieBox Worker wrapper',
  });
}

async function handleSearch(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {}

  const url = new URL(request.url);
  const searchQuery = (body.keyword ?? body.word ?? url.searchParams.get('word') ?? url.searchParams.get('keyword')) as string;
  if (!searchQuery?.trim()) return err('keyword is required');

  const page = Number(body.page ?? url.searchParams.get('page') ?? 1);
  const perPage = Number(body.perPage ?? url.searchParams.get('perPage') ?? 20);

  // Pass search params into Argument 4 (params -> query string), leaving body undefined (Argument 5)
  const data = await fetchWithHostPool<MBSearchData>(
    env, PATHS.search, 'POST',
    { word: searchQuery, page, perPage, subjectType: 0 },
    undefined
  );

  if (!data) return json({ items: [], pager: null });

  const items = (data.items || [])
    .filter((item) => ALLOWED_SUBJECT_TYPES.has(item.subjectType))
    .map((item) => ({
      subjectId:   item.subjectId,
      subjectType: item.subjectType,
      title:       item.title,
      description: item.description ?? '',
      releaseDate: item.releaseDate ?? null,
      duration:    item.duration ?? null,
      genre:       item.genre ?? null,
      poster:      item.cover?.url ?? null,
      thumbnail:   item.cover?.thumbnail ?? null,
      country:     item.countryName ?? null,
      rating:      item.imdbRatingValue && item.imdbRatingValue !== '0' ? parseFloat(item.imdbRatingValue) : null,
      language:    item.language ?? null,
      type:        resolveSubjectType(item.subjectType),
    }));

  return json({ items, pager: data.pager });
}

async function handleInfo(subjectId: string, env: Env): Promise<Response> {
  const data = await fetchWithHostPool<MBDetailData>(env, PATHS.get, 'GET', { subjectId });
  if (!data?.subjectId) return err('Not found', 404);

  return json({
    subjectId:   data.subjectId,
    subjectType: data.subjectType,
    type:        resolveSubjectType(data.subjectType),
    title:       data.title,
    description: data.description ?? '',
    releaseDate: data.releaseDate ?? null,
    genre:       data.genre ?? null,
    poster:      data.cover?.url ?? null,
    country:     data.countryName ?? null,
    rating:      data.imdbRatingValue && data.imdbRatingValue !== '0' ? parseFloat(data.imdbRatingValue) : null,
    hasResource: data.hasResource ?? false,
    language:    data.language ?? null,
  });
}

async function handleSeason(subjectId: string, env: Env): Promise<Response> {
  const data = await fetchWithHostPool<MBSeasonData>(env, PATHS.seasonInfo, 'GET', { subjectId });
  if (!data?.seasons?.length) return json({ seasons: [] });

  return json({
    seasons: data.seasons.map((s) => ({
      season:             s.se,
      totalEpisode:       s.maxEp,
      episodesAvailable:  s.resolutions?.length ? Math.max(...s.resolutions.map((r) => r.epNum)) : s.maxEp,
      resolutions:        s.resolutions || [],
      episodes:           Array.from({ length: s.maxEp }, (_, i) => ({ episode: i + 1, title: null, releaseDate: null })),
    })),
  });
}

async function handleStream(subjectId: string, se: number, ep: number, env: Env): Promise<Response> {
  const pack = await fetchResourcePack(env, subjectId);
  if (!pack) return err('No streams available', 404);

  const isMovie = se === 0 && ep === 0;
  let items = isMovie ? pack : pack.filter((r) => r.se === se && r.ep === ep);
  if (!items.length) return err('No streams available for this episode', 404);

  const seen = new Set<string>();
  const streams = await Promise.all(
    items.filter((item) => {
      const q = `${item.resolution}p`;
      if (seen.has(q)) return false;
      seen.add(q);
      return true;
    }).map((item) => mapResourceItem(item, env))
  );

  return json({ streams, total: streams.length });
}

async function handleDownload(subjectId: string, env: Env): Promise<Response> {
  const pack = await fetchResourcePack(env, subjectId);
  if (!pack) return err('No downloads available', 404);

  const detail = await fetchWithHostPool<MBDetailData>(env, PATHS.get, 'GET', { subjectId });
  const subjectTitle = detail?.title?.trim() || `Subject_${subjectId}`;
  const subjectType = detail?.subjectType ?? (pack.every((item) => item.se === 0 && item.ep === 0) ? 1 : 2);

  const seasonMap = new Map<number, Map<number, Awaited<ReturnType<typeof mapResourceItem>>[]>>();

  for (const item of pack) {
    if (!seasonMap.has(item.se)) seasonMap.set(item.se, new Map());
    const epMap = seasonMap.get(item.se)!;

    if (!epMap.has(item.ep)) epMap.set(item.ep, []);
    const qualities = epMap.get(item.ep)!;

    const q = `${item.resolution}p`;
    if (!qualities.find((x) => x.quality === q)) {
      const filename = buildDownloadFilename(subjectTitle, subjectType, item);
      qualities.push(await mapResourceItem(item, env, true, filename));
    }
  }

  const seasons = [...seasonMap.entries()].map(([seasonNum, epMap]) => ({
    season: seasonNum,
    episodes: [...epMap.entries()].map(([epNum, qualities]) => ({ episode: epNum, qualities })),
  }));

  return json({ seasons, total_seasons: seasons.length });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin':  '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Worker-Secret',
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/' && request.method === 'GET') return handleRoot();
    if (path === '/health' && request.method === 'GET') return json({ status: 'ok', ts: Date.now() });
    if (!isAuthorized(request, env)) return err('Unauthorized', 401);

    if (path === '/search' && request.method === 'POST') return handleSearch(request, env);

    const infoMatch = path.match(/^\/info\/([^/]+)$/);
    if (infoMatch && request.method === 'GET') return handleInfo(infoMatch[1], env);

    const seasonMatch = path.match(/^\/season\/([^/]+)$/);
    if (seasonMatch && request.method === 'GET') return handleSeason(seasonMatch[1], env);

    const streamMatch = path.match(/^\/stream\/([^/]+)$/);
    if (streamMatch && request.method === 'GET') {
      const se = parseInt(url.searchParams.get('se') ?? '0');
      const ep = parseInt(url.searchParams.get('ep') ?? '0');
      return handleStream(streamMatch[1], se, ep, env);
    }

    const downloadMatch = path.match(/^\/download\/([^/]+)$/);
    if (downloadMatch && request.method === 'GET') return handleDownload(downloadMatch[1], env);

    return err('Not found', 404);
  },
};
