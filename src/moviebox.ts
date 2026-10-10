// src/moviebox.ts
// MovieBox Mobile API client for Cloudflare Workers.
// Handles host pool fallback, request signing, auth token bootstrap, and all
// endpoint calls.

import {
  generateClientToken,
  generateSignature,
  getCachedAuthToken,
  bootstrapAuthToken,
  invalidateAuthToken,
  type SigningEnv,
} from './signing.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const HOST_POOL = [
  'https://api6.aoneroom.com',
  'https://api5.aoneroom.com',
  'https://api4.aoneroom.com',
  'https://api4sg.aoneroom.com',
  'https://api3.aoneroom.com',
  'https://api6sg.aoneroom.com',
  'https://api.inmoviebox.com',
];

const VERSION_CODE = 50020125;
const VERSION_NAME = '4.0.02.0828.03';
const ANDROID_VERSION = '13';
const ANDROID_BUILD = 'TQ2A.230405.003';
const DEVICE_MODEL = '23078RKD5C';
const DEVICE_BRAND = 'Redmi';

const USER_AGENT =
  `com.community.oneroom/${VERSION_CODE} ` +
  `(Linux; U; Android ${ANDROID_VERSION}; en_US; ` +
  `${DEVICE_MODEL}; Build/${ANDROID_BUILD}; Cronet/135.0.7012.3)`;

// ─── Paths ────────────────────────────────────────────────────────────────────

export const PATHS = {
  search:        '/wefeed-mobile-bff/subject-api/search/v2',
  get:           '/wefeed-mobile-bff/subject-api/get',
  seasonInfo:    '/wefeed-mobile-bff/subject-api/season-info',
  resource:      '/wefeed-mobile-bff/subject-api/resource',
  captions:      '/wefeed-mobile-bff/subject-api/get-ext-captions',
  tabOperating:  '/wefeed-mobile-bff/tab-operating',
};

// ─── Client identity ──────────────────────────────────────────────────────────

function makeClientInfo(): string {
  const deviceId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const gaid = crypto.randomUUID();

  return JSON.stringify({
    package_name:    'com.community.oneroom',
    version_name:    VERSION_NAME,
    version_code:    VERSION_CODE,
    os:              'android',
    os_version:      ANDROID_VERSION,
    install_ch:      'ps',
    device_id:       deviceId,
    install_store:   'ps',
    gaid,
    brand:           DEVICE_BRAND,
    model:           DEVICE_MODEL,
    system_language: 'en',
    net:             'NETWORK_WIFI',
    region:          'US',
    timezone:        'America/New_York',
    sp_code:         '40401',
    'X-Play-Mode':   '2',
  });
}

let _clientInfo: string | null = null;
function getClientInfo(): string {
  if (!_clientInfo) _clientInfo = makeClientInfo();
  return _clientInfo;
}

// ─── Signed headers builder ───────────────────────────────────────────────────

async function buildHeaders(
  method: string,
  url: string,
  body: string | null = null,
  authToken: string | null = null
): Promise<Record<string, string>> {
  const accept = 'application/json';
  const contentType = body !== null ? 'application/json; charset=utf-8' : 'application/json';
  const ts = Date.now();

  const [token, signature] = await Promise.all([
    generateClientToken(ts),
    generateSignature(method, accept, contentType, url, body, ts),
  ]);

  const headers: Record<string, string> = {
    'User-Agent':      USER_AGENT,
    'Accept':          accept,
    'Content-Type':    contentType,
    'Connection':      'keep-alive',
    'X-Client-Token':  token,
    'x-tr-signature':  signature,
    'X-Client-Info':   getClientInfo(),
    'X-Client-Status': '0',
    'X-Play-Mode':     '2',
  };

  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  return headers;
}

// ─── Relay fetch implementation ───────────────────────────────────────────────

interface RelayResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function parseRelayResult(value: unknown): RelayResult {
  if (!value || typeof value !== 'object') {
    throw new Error('relay returned a non-object response');
  }

  const envelope = value as Record<string, unknown>;
  const status = envelope.status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error('relay returned an invalid upstream status');
  }
  
  const body = typeof envelope.body === 'string' 
    ? envelope.body 
    : JSON.stringify(envelope.body ?? '');

  const rawHeaders = envelope.headers;
  const headers: Record<string, string> = {};
  
  if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
    for (const [key, headerValue] of Object.entries(rawHeaders)) {
      if (typeof headerValue === 'string') {
        headers[key.toLowerCase()] = headerValue;
      }
    }
  }

  return { status, headers, body };
}

async function relayFetch(
  env: SigningEnv,
  url: string,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  bodyStr: string | null
): Promise<RelayResult> {
  const relayBaseUrl = env.RELAY_URL?.trim().replace(/\/+$/, '');
  if (!relayBaseUrl) {
    throw new Error('RELAY_URL is not configured');
  }
  if (!env.RELAY_SECRET) {
    throw new Error('RELAY_SECRET is not configured');
  }

  const relayEndpoint = `${relayBaseUrl}/api/relay`;

  const relayResponse = await fetch(relayEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Relay-Secret': env.RELAY_SECRET,
    },
    body: JSON.stringify({ url, method, headers, body: bodyStr }),
    signal: AbortSignal.timeout(20000),
  });

  if (!relayResponse.ok) {
    const detail = await relayResponse.text().catch(() => '');
    throw new Error(`relay error ${relayResponse.status}: ${detail}`);
  }

  const responseText = await relayResponse.text();
  if (!responseText) {
    throw new Error('relay returned an empty response');
  }

  let rawEnvelope: unknown;
  try {
    rawEnvelope = JSON.parse(responseText);
  } catch {
    throw new Error(`relay returned invalid JSON: ${responseText.slice(0, 100)}`);
  }

  return parseRelayResult(rawEnvelope);
}

function extractXUserTokenFromHeaders(headers: Record<string, string>): string | null {
  const xUser = headers['x-user'] ?? headers['X-User'];
  if (!xUser) return null;
  try {
    const payload = JSON.parse(xUser) as { token?: string };
    return payload.token ?? null;
  } catch {
    return null;
  }
}

interface HostPoolAttemptResult<T> {
  data: T | null;
  freshXUserToken: string | null;
  authFailure: boolean;
}

async function attemptHostPool<T>(
  env: SigningEnv,
  path: string,
  method: 'GET' | 'POST',
  params: Record<string, string | number> | undefined,
  bodyStr: string | null,
  authToken: string | null
): Promise<HostPoolAttemptResult<T>> {
  let freshXUserToken: string | null = null;
  let sawAuthFailure = false;
  let sawAnyResponse = false;

  for (const base of HOST_POOL) {
    const url = new URL(`${base}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, String(value));
      }
    }

    const urlStr = url.toString();
    const headers = await buildHeaders(method, urlStr, bodyStr, authToken);

    try {
      const relayResult = await relayFetch(env, urlStr, method, headers, bodyStr);

      sawAnyResponse = true;

      const xUserToken = extractXUserTokenFromHeaders(relayResult.headers);
      if (xUserToken) freshXUserToken = xUserToken;

      if (relayResult.status === 401 || relayResult.status === 403) {
        console.warn(`[MovieBox] Host ${base} returned ${relayResult.status} (auth) — trying next`);
        sawAuthFailure = true;
        continue;
      }

      if (relayResult.status < 200 || relayResult.status >= 300) {
        console.warn(`[MovieBox] Host ${base} returned ${relayResult.status} — trying next`);
        continue;
      }

      const data = JSON.parse(relayResult.body) as { code: number; message?: string; data?: T };

      if (data.code === 0) {
        return { data: (data.data ?? null) as T | null, freshXUserToken, authFailure: false };
      }

      console.warn(`[MovieBox] Host ${base} returned API code ${data.code}: ${data.message ?? ''} — trying next`);
      if (data.message && /token|auth/i.test(data.message)) {
        sawAuthFailure = true;
      }
    } catch (err) {
      console.warn(`[MovieBox] Host ${base} failed: ${err} — trying next`);
    }
  }

  console.error(`[MovieBox] All ${HOST_POOL.length} hosts exhausted for ${path}`);
  return {
    data: null,
    freshXUserToken,
    authFailure: sawAnyResponse && sawAuthFailure,
  };
}

export async function fetchWithHostPool<T>(
  env: SigningEnv,
  path: string,
  method: 'GET' | 'POST',
  params?: Record<string, string | number>,
  body?: Record<string, unknown>
): Promise<T | null> {
  const bodyStr = body ? JSON.stringify(body) : null;

  let authToken = await getCachedAuthToken(env);

  if (!authToken) {
    try {
      authToken = await bootstrapAuthToken(env, async () => {
        const result = await attemptHostPool<unknown>(
          env,
          PATHS.tabOperating,
          'GET',
          { page: 1, tabId: 0, version: '' },
          null,
          null
        );
        // Fallback: if upstream doesn't return x-user token, use a dummy placeholder token so requests still succeed
        return result.freshXUserToken ?? 'bypassed_auth_token';
      });
    } catch (e) {
      console.warn(`[MovieBox] Auth bootstrap soft-failed, proceeding with bypass token: ${e}`);
      authToken = 'bypassed_auth_token';
    }
  }

  let result = await attemptHostPool<T>(env, path, method, params, bodyStr, authToken);

  if (result.freshXUserToken && result.freshXUserToken !== authToken) {
    await bootstrapAuthToken(env, async () => result.freshXUserToken).catch(() => {});
  }

  if (result.data !== null) {
    return result.data;
  }

  if (result.authFailure) {
    console.warn(`[MovieBox] Auth failure on ${path} — invalidating token and retrying once`);
    await invalidateAuthToken(env);

    try {
      authToken = await bootstrapAuthToken(env, async () => {
        const bootstrapResult = await attemptHostPool<unknown>(
          env,
          PATHS.tabOperating,
          'GET',
          { page: 1, tabId: 0, version: '' },
          null,
          null
        );
        return bootstrapResult.freshXUserToken ?? 'bypassed_auth_token';
      });
    } catch {
      authToken = 'bypassed_auth_token';
    }

    result = await attemptHostPool<T>(env, path, method, params, bodyStr, authToken);
    return result.data;
  }

  return null;
}

// ─── Raw API response shapes ──────────────────────────────────────────────────

export interface MBSearchItem {
  subjectId:        string;
  subjectType:      number;
  title:            string;
  description?:     string;
  releaseDate?:     string;
  duration?:        string;
  genre?:           string;
  cover?:           { url: string; thumbnail?: string };
  countryName?:     string;
  imdbRatingValue?: string;
  language?:        string;
}

export interface MBSearchData {
  pager: { hasMore: boolean; nextPage: string; page: string; perPage: number; totalCount: number };
  items: MBSearchItem[];
}

export interface MBDetailData {
  subjectId:        string;
  subjectType:      number;
  title:            string;
  description?:     string;
  releaseDate?:     string;
  duration?:        number | string;
  genre?:           string;
  cover?:           { url: string };
  countryName?:     string;
  imdbRatingValue?: string;
  hasResource?:     boolean;
  language?:        string;
  staffList?:       Array<{ name: string; role: string; avatar?: { url?: string } }>;
}

export interface MBSeasonData {
  subjectId?:   string;
  subjectType?: number;
  seasons?: Array<{
    se:             number;
    maxEp:          number;
    allEp?:         string;
    resolutions?: Array<{ resolution: number; epNum: number }>;
  }>;
}

export interface MBResourceItem {
  episode:            number;
  title:              string;
  resourceLink:       string;
  linkType:           number;
  size?:              string;
  resourceId:         string;
  resolution:         number;
  codecName?:         string;
  duration?:          number;
  requireMemberType?: number;
  extCaptions?:       Array<{ lan: string; lanName?: string; url: string }>;
  se:                 number;
  ep:                 number;
}

export interface MBResourceData {
  pager: { hasMore: boolean; totalCount: number; nextPage?: string; page?: string; perPage?: number };
  list:  MBResourceItem[];
}
