
// src/index.ts
// Spün MovieBox API

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

const ALLOWED_SUBJECT_TYPES = new Set([1, 2, 7]);

function resolveSubjectType(subjectType: number): 'movie' | 'tv' | 'shorts' {
  if (subjectType === 2) return 'tv';
  if (subjectType === 7) return 'shorts';
  return 'movie';
}

export interface Env extends SigningEnv {
  MOVIEBOX_SECRET: string;
  NIGERIA_IP?: string;
  RELAY_URL: string;
  RELAY_SECRET: string;
  MOVIEBOX_SESSION_KV: KVNamespace;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store',
    },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  fr: 'Français',
  ar: 'Arabic',
  zh: 'Chinese',
  ru: 'Russian',
  pt: 'Português',
  es: 'Spanish',
  de: 'German',
  ja: 'Japanese',
  ko: 'Korean',
  it: 'Italian',
  sw: 'Kiswahili',
  ha: 'Hausa',
  ms: 'Malay',
  bn: 'Bengali',
  ur: 'Urdu',
  pa: 'Punjabi',
  fil: 'Filipino',
  id: 'Indonesian',
};

const RESOLUTIONS = [360, 480, 720, 1080];

async function fetchResourcePack(
  env: Env,
  subjectId: string
): Promise<MBResourceItem[] | null> {
  const seenResourceIds = new Set<string>();
  const allItems: MBResourceItem[] = [];
  const perPage = 10;

  for (const resolution of RESOLUTIONS) {
    let page = 1;

    while (true) {
      const data = await fetchWithHostPool<MBResourceData>(
        env,
        PATHS.resource,
        'GET',
        { subjectId, se: 0, ep: 0, resolution, page, perPage }
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

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
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

  return Array.from(
    new Uint8Array(signature),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');
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

function buildDownloadFilename(
  title: string,
  subjectType: number,
  item: MBResourceItem
): string {
  const titlePart = sanitizeFilenamePart(title, 'MovieBox');

  const qualityPart =
    Number.isFinite(item.resolution) && item.resolution > 0
      ? `${item.resolution}p`
      : 'unknown';

  const episodePart =
    subjectType === 1
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

  if (
    !relayBaseUrl ||
    !relaySecret ||
    target.protocol !== 'https:' ||
    target.hostname.toLowerCase() !== 'bcdn.hakunaymatata.com'
  ) {
    return resourceLink;
  }

  const expires = Number.parseInt(target.searchParams.get('t') ?? '', 10);

  if (!Number.isInteger(expires)) return resourceLink;

  const signature = await signMediaProxyTarget(
    expires,
    target.toString(),
    relaySecret,
    filename
  );

const proxy = new URL(
  relayBaseUrl + '/media/' + base64UrlEncode(target.toString())
);
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
    language: cap.lanName || LANGUAGE_NAMES[cap.lan] || cap.lan,
    language_code: cap.lan,
    url: cap.url,
  }));

  return {
    quality: `${item.resolution}p`,
    resolution: item.resolution,
    url: await proxyMediaUrl(item.resourceLink, env, download, filename),
    filename: filename ?? null,
    format: 'mp4' as const,
    size: sizeMb,
    codecName: item.codecName ?? null,
    duration: item.duration ?? null,
    captions,
    se: item.se,
    ep: item.ep,
  };
}

function handleRoot(): Response {
  return json({
    name: 'Spün MovieBox API',
    version: '1.1.0',
    description: 'Spün MovieBox API',
  });
}

async function handleSearch(
  request: Request,
  env: Env
): Promise<Response> {
  let body: Record<string, unknown> = {};

  try {
    body = await request.json() as Record<string, unknown>;
  } catch {}

  const url = new URL(request.url);

  const rawQuery = (
    body.keyword ??
    body.word ??
    body.query ??
    url.searchParams.get('keyword') ??
    url.searchParams.get('word') ??
    url.searchParams.get('query')
  ) as string;

  if (!rawQuery?.trim()) {
    return err('keyword is required');
  }

  const searchQuery = rawQuery
    .replace(/\s*\(\d{4}\)|\s+\d{4}$/, '')
    .replace(/[:\-_/\\.,?!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const page = Number(body.page ?? url.searchParams.get('page') ?? 1);
  const perPage = Number(
    body.perPage ?? url.searchParams.get('perPage') ?? 20
  );

  console.log(
    `[MovieBox Search] Searching upstream for: "${searchQuery}" (Raw: "${rawQuery}")`
  );

  const data = await fetchWithHostPool<MBSearchData>(
    env,
    PATHS.search,
    'POST',
    undefined,
    {
      keyword: searchQuery,
      type: 0,
      subjectType: 0,
      page,
      perPage,
    }
  );

  console.log(
    `[MovieBox Search] Response received. Items count: ${data?.items?.length ?? 0}`
  );

  if (!data) {
    return json(
      {
        error: 'MovieBox upstream search failed. Check Worker logs and relay configuration.',
      },
      502
    );
  }

  const items = (data.items || [])
    .filter((item) => ALLOWED_SUBJECT_TYPES.has(item.subjectType))
    .map((item) => ({
      subjectId: item.subjectId,
      subjectType: item.subjectType,
      title: item.title,
      description: item.description ?? '',
      releaseDate: item.releaseDate ?? null,
      duration: item.duration ?? null,
      genre: item.genre ?? null,
      poster: item.cover?.url ?? null,
      thumbnail: item.cover?.thumbnail ?? null,
      country: item.countryName ?? null,
      rating:
        item.imdbRatingValue && item.imdbRatingValue !== '0'
          ? parseFloat(item.imdbRatingValue)
          : null,
      language: item.language ?? null,
      type: resolveSubjectType(item.subjectType),
    }));

  return json({ items, pager: data.pager });
}

async function handleInfo(
  subjectId: string,
  env: Env
): Promise<Response> {
  const data = await fetchWithHostPool<MBDetailData>(
    env,
    PATHS.get,
    'GET',
    { subjectId }
  );

  if (!data?.subjectId) return err('Not found', 404);

  return json({
    subjectId: data.subjectId,
    subjectType: data.subjectType,
    type: resolveSubjectType(data.subjectType),
    title: data.title,
    description: data.description ?? '',
    releaseDate: data.releaseDate ?? null,
    genre: data.genre ?? null,
    poster: data.cover?.url ?? null,
    country: data.countryName ?? null,
    rating:
      data.imdbRatingValue && data.imdbRatingValue !== '0'
        ? parseFloat(data.imdbRatingValue)
        : null,
    hasResource: data.hasResource ?? false,
    language: data.language ?? null,
  });
}

async function handleSeason(
  subjectId: string,
  env: Env
): Promise<Response> {
  const data = await fetchWithHostPool<MBSeasonData>(
    env,
    PATHS.seasonInfo,
    'GET',
    { subjectId }
  );

  if (!data?.seasons?.length) {
    return json({ seasons: [] });
  }

  return json({
    seasons: data.seasons.map((s) => ({
      season: s.se,
      totalEpisode: s.maxEp,
      episodesAvailable: s.resolutions?.length
        ? Math.max(...s.resolutions.map((r) => r.epNum))
        : s.maxEp,
      resolutions: s.resolutions || [],
      episodes: Array.from(
        { length: s.maxEp },
        (_, i) => ({
          episode: i + 1,
          title: null,
          releaseDate: null,
        })
      ),
    })),
  });
}

async function handleStream(
  subjectId: string,
  se: number,
  ep: number,
  env: Env
): Promise<Response> {
  const pack = await fetchResourcePack(env, subjectId);

  if (!pack) return err('No streams available', 404);

  const isMovie = se === 0 && ep === 0;
  const items = isMovie
    ? pack
    : pack.filter((r) => r.se === se && r.ep === ep);

  if (!items.length) {
    return err('No streams available for this episode', 404);
  }

  const seen = new Set<string>();

  const streams = await Promise.all(
    items
      .filter((item) => {
        const quality = `${item.resolution}p`;

        if (seen.has(quality)) return false;

        seen.add(quality);
        return true;
      })
      .map((item) => mapResourceItem(item, env))
  );

  return json({ streams, total: streams.length });
}

async function handleDownload(
  subjectId: string,
  env: Env
): Promise<Response> {
  const pack = await fetchResourcePack(env, subjectId);

  if (!pack) return err('No downloads available', 404);

  const detail = await fetchWithHostPool<MBDetailData>(
    env,
    PATHS.get,
    'GET',
    { subjectId }
  );

  const subjectTitle = detail?.title?.trim() || `Subject_${subjectId}`;

  const subjectType =
    detail?.subjectType ??
    (pack.every((item) => item.se === 0 && item.ep === 0) ? 1 : 2);

  const seasonMap = new Map<
    number,
    Map<number, Awaited<ReturnType<typeof mapResourceItem>>[]>
  >();

  for (const item of pack) {
    if (!seasonMap.has(item.se)) {
      seasonMap.set(item.se, new Map());
    }

    const epMap = seasonMap.get(item.se)!;

    if (!epMap.has(item.ep)) {
      epMap.set(item.ep, []);
    }

    const qualities = epMap.get(item.ep)!;
    const quality = `${item.resolution}p`;

    if (!qualities.find((x) => x.quality === quality)) {
      const filename = buildDownloadFilename(
        subjectTitle,
        subjectType,
        item
      );

      qualities.push(
        await mapResourceItem(item, env, true, filename)
      );
    }
  }

  const seasons = [...seasonMap.entries()].map(
    ([seasonNum, epMap]) => ({
      season: seasonNum,
      episodes: [...epMap.entries()].map(
        ([epNum, qualities]) => ({
          episode: epNum,
          qualities,
        })
      ),
    })
  );

  return json({
    seasons,
    total_seasons: seasons.length,
  });
}

async function handleRequest(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/' && request.method === 'GET') {
    return handleRoot();
  }

  if (path === '/health' && request.method === 'GET') {
    const configured = Boolean(
      env.RELAY_URL?.trim() &&
      env.RELAY_SECRET?.trim() &&
      env.MOVIEBOX_SECRET?.trim()
    );

    return json({
      status: configured ? 'ok' : 'misconfigured',
      ts: Date.now(),
      configured,
    });
  }

  if (path === '/debug-probe' && request.method === 'GET') {
    const testQuery = url.searchParams.get('q') ?? 'Avatar';

    const result = await fetchWithHostPool<MBSearchData>(
      env,
      PATHS.search,
      'POST',
      undefined,
      {
        keyword: testQuery,
        type: 0,
        subjectType: 0,
        page: 1,
        perPage: 10,
      }
    );

    if (!result) {
      return json(
        {
          error: 'Upstream probe failed',
          queryUsed: testQuery,
        },
        502
      );
    }

    return json({
      queryUsed: testQuery,
      upstreamResult: result,
    });
  }

  if (path === '/search') {
    return handleSearch(request, env);
  }

  const infoMatch = path.match(/^\/info\/([^/]+)$/);

  if (infoMatch) {
    return handleInfo(infoMatch[1], env);
  }

  const seasonMatch = path.match(/^\/season\/([^/]+)$/);

  if (seasonMatch) {
    return handleSeason(seasonMatch[1], env);
  }

  const streamMatch = path.match(/^\/stream\/([^/]+)$/);

  if (streamMatch) {
    const se = parseInt(url.searchParams.get('se') ?? '0');
    const ep = parseInt(url.searchParams.get('ep') ?? '0');

    return handleStream(streamMatch[1], se, ep, env);
  }

  const downloadMatch = path.match(/^\/download\/([^/]+)$/);

  if (downloadMatch) {
    return handleDownload(downloadMatch[1], env);
  }

  return err('Not found', 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error('[Worker Request Error]', error);

      const message =
        error instanceof Error
          ? error.message
          : 'Internal Server Error';

      return json({ error: message }, 500);
    }
  },
}
