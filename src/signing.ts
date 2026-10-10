// src/signing.ts
// MovieBox Mobile API v3 request signing — updated for Vercel Serverless Runtime compatibility

// @ts-ignore
import md5 from 'js-md5';

const SECRET_KEY_B64 = '76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O';
const SIGNATURE_BODY_MAX_BYTES = 102_400;

// ─── Base64 helpers ────────────────────────────────────────────────────────────

function b64Decode(value: string): Uint8Array {
  const padding = (4 - (value.length % 4)) % 4;
  const padded = value + '='.repeat(padding);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function b64Encode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

// ─── MD5 via js-md5 ────────────────────────────────────────────────────────────

async function md5Hex(data: string | Uint8Array): Promise<string> {
  if (data instanceof Uint8Array) {
    return md5(data);
  }
  return md5(data);
}

// ─── HMAC-MD5 via js-md5 ───────────────────────────────────────────────────────

async function hmacMd5(keyBytes: Uint8Array, message: string): Promise<ArrayBuffer> {
  // Use md5.hmac.array() for 100% bundler compatibility and convert to ArrayBuffer
  const bytes = md5.hmac.array(keyBytes, message);
  return new Uint8Array(bytes).buffer;
}

// ─── Token & signature generators ─────────────────────────────────────────────

export async function generateClientToken(ts: number): Promise<string> {
  const tsStr = String(ts);
  const reversed = tsStr.split('').reverse().join('');
  const hash = await md5Hex(reversed);
  return `${tsStr},${hash}`;
}

function sortedQueryString(url: string): string {
  const u = new URL(url);
  const params: string[] = [];
  const sorted = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, value] of sorted) {
    params.push(`${key}=${value}`);
  }
  return params.join('&');
}

async function buildCanonicalString(
  method: string,
  accept: string,
  contentType: string,
  url: string,
  body: string | null,
  ts: number
): Promise<string> {
  const u = new URL(url);
  const path = u.pathname;
  const query = sortedQueryString(url);
  const canonicalUrl = query ? `${path}?${query}` : path;

  let bodyHash = '';
  let bodyLength = '';

  if (body !== null) {
    const bodyBytes = new TextEncoder().encode(body);
    const truncated = bodyBytes.slice(0, SIGNATURE_BODY_MAX_BYTES);
    bodyHash = await md5Hex(truncated);
    bodyLength = String(bodyBytes.length);
  }

  return [method.toUpperCase(), accept, contentType, bodyLength, ts, bodyHash, canonicalUrl].join(
    '\n'
  );
}

export async function generateSignature(
  method: string,
  accept: string,
  contentType: string,
  url: string,
  body: string | null,
  ts: number
): Promise<string> {
  const canonical = await buildCanonicalString(method, accept, contentType, url, body, ts);
  const secretBytes = b64Decode(SECRET_KEY_B64);
  const mac = await hmacMd5(secretBytes, canonical);
  return `${ts}|2|${b64Encode(mac)}`;
}

// ─── Auth token bootstrap (KV-backed) ─────────────────────────────────────────

export interface SigningEnv {
  MOVIEBOX_SESSION_KV: KVNamespace;
  RELAY_URL: string;
  RELAY_SECRET: string;
}

const KV_TOKEN_KEY = 'mobile_auth_token';
const KV_TTL_SECONDS = 60 * 60 * 24; 
const EXPIRY_SAFETY_MARGIN_SECONDS = 300;

interface CachedToken {
  token: string;
  expiresAtSeconds: number;
}

let _bootstrapPromise: Promise<string> | null = null;

function decodeJwtExpSeconds(jwt: string): number | null {
  try {
    const payloadB64 = jwt.split('.')[1];
    if (!payloadB64) return null;
    const padded = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (padded.length % 4)) % 4);
    const json = atob(padded + padding);
    const payload = JSON.parse(json) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

async function readTokenFromKv(kv: KVNamespace): Promise<CachedToken | null> {
  try {
    const raw = await kv.get(KV_TOKEN_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CachedToken;
  } catch (e) {
    console.warn(`[Signing] Failed to read/parse KV token: ${e}`);
    return null;
  }
}

async function writeTokenToKv(kv: KVNamespace, cached: CachedToken): Promise<void> {
  try {
    await kv.put(KV_TOKEN_KEY, JSON.stringify(cached), { expirationTtl: KV_TTL_SECONDS });
  } catch (e) {
    console.warn(`[Signing] Failed to write token to KV: ${e}`);
  }
}

function isExpiringSoon(cached: CachedToken): boolean {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return nowSeconds >= cached.expiresAtSeconds - EXPIRY_SAFETY_MARGIN_SECONDS;
}

export async function bootstrapAuthToken(
  env: SigningEnv,
  signedFetch: () => Promise<string | null>
): Promise<string> {
  if (!_bootstrapPromise) {
    _bootstrapPromise = (async () => {
      const token = await signedFetch();
      if (!token) {
        throw new Error('[Signing] Bootstrap failed — no x-user token received from any host');
      }

      const exp = decodeJwtExpSeconds(token);
      const expiresAtSeconds = exp ?? Math.floor(Date.now() / 1000) + 3600;

      await writeTokenToKv(env.MOVIEBOX_SESSION_KV, { token, expiresAtSeconds });

      return token;
    })().finally(() => {
      _bootstrapPromise = null;
    });
  }

  return _bootstrapPromise;
}

export async function getCachedAuthToken(env: SigningEnv): Promise<string | null> {
  const cached = await readTokenFromKv(env.MOVIEBOX_SESSION_KV);
  if (cached && !isExpiringSoon(cached)) {
    return cached.token;
  }
  return null;
}

export async function invalidateAuthToken(env: SigningEnv): Promise<void> {
  try {
    await env.MOVIEBOX_SESSION_KV.delete(KV_TOKEN_KEY);
  } catch (e) {
    console.warn(`[Signing] Failed to invalidate KV token: ${e}`);
  }
}
