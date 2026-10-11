// src/signing.ts
// Request signing and KV-backed authentication-token caching for the Cloudflare Worker.

// @ts-ignore - js-md5 supports strings and Uint8Array inputs.
import md5 from 'js-md5';

const SECRET_KEY_B64 = '76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O';
const SIGNATURE_BODY_MAX_BYTES = 102_400;

function b64Decode(value: string): Uint8Array {
  const padding = (4 - (value.length % 4)) % 4;
  const binary = atob(value + '='.repeat(padding));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function b64Encode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function md5Hex(data: string | Uint8Array): string {
  return md5(data);
}

async function hmacMd5(keyBytes: Uint8Array, message: string): Promise<ArrayBuffer> {
  const blockSize = 64;
  let key = keyBytes;
  if (key.length > blockSize) key = hexToBytes(md5Hex(key));
  if (key.length < blockSize) {
    const padded = new Uint8Array(blockSize);
    padded.set(key);
    key = padded;
  }

  const oKeyPad = new Uint8Array(blockSize);
  const iKeyPad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    oKeyPad[i] = key[i] ^ 0x5c;
    iKeyPad[i] = key[i] ^ 0x36;
  }

  const messageBytes = new TextEncoder().encode(message);
  const innerInput = new Uint8Array(iKeyPad.length + messageBytes.length);
  innerInput.set(iKeyPad);
  innerInput.set(messageBytes, iKeyPad.length);
  const innerHashBytes = hexToBytes(md5Hex(innerInput));

  const outerInput = new Uint8Array(oKeyPad.length + innerHashBytes.length);
  outerInput.set(oKeyPad);
  outerInput.set(innerHashBytes, oKeyPad.length);
  return hexToBytes(md5Hex(outerInput)).buffer as ArrayBuffer;
}

export async function generateClientToken(ts: number): Promise<string> {
  const tsStr = String(ts);
  const hash = md5Hex(tsStr.split('').reverse().join(''));
  return `${tsStr},${hash}`;
}

function sortedQueryString(url: string): string {
  const u = new URL(url);
  return [...u.searchParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
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
  const query = sortedQueryString(url);
  const canonicalUrl = query ? `${u.pathname}?${query}` : u.pathname;
  let bodyHash = '';
  let bodyLength = '';
  if (body !== null) {
    const bodyBytes = new TextEncoder().encode(body);
    bodyHash = md5Hex(bodyBytes.slice(0, SIGNATURE_BODY_MAX_BYTES));
    bodyLength = String(bodyBytes.length);
  }
  return [method.toUpperCase(), accept, contentType, bodyLength, ts, bodyHash, canonicalUrl].join('\n');
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
  const mac = await hmacMd5(b64Decode(SECRET_KEY_B64), canonical);
  return `${ts}|2|${b64Encode(mac)}`;
}

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

let bootstrapPromise: Promise<string> | null = null;

function decodeJwtExpSeconds(jwt: string): number | null {
  try {
    const payloadB64 = jwt.split('.')[1];
    if (!payloadB64) return null;
    const normalized = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

async function readTokenFromKv(kv: KVNamespace): Promise<CachedToken | null> {
  try {
    const raw = await kv.get(KV_TOKEN_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as Partial<CachedToken>;
    if (typeof cached.token !== 'string' || !cached.token || typeof cached.expiresAtSeconds !== 'number') return null;
    return { token: cached.token, expiresAtSeconds: cached.expiresAtSeconds };
  } catch (error) {
    console.warn('[Signing] Failed to read/parse KV token:', error);
    return null;
  }
}

async function writeTokenToKv(kv: KVNamespace, cached: CachedToken): Promise<void> {
  try {
    await kv.put(KV_TOKEN_KEY, JSON.stringify(cached), { expirationTtl: KV_TTL_SECONDS });
  } catch (error) {
    console.warn('[Signing] Failed to write token to KV:', error);
  }
}

function isExpiringSoon(cached: CachedToken): boolean {
  return Math.floor(Date.now() / 1000) >= cached.expiresAtSeconds - EXPIRY_SAFETY_MARGIN_SECONDS;
}

export async function bootstrapAuthToken(
  env: SigningEnv,
  signedFetch: () => Promise<string | null>
): Promise<string> {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      const token = await signedFetch();
      if (!token) throw new Error('Bootstrap response did not contain an x-user token');
      const expiresAtSeconds = decodeJwtExpSeconds(token) ?? Math.floor(Date.now() / 1000) + 3600;
      await writeTokenToKv(env.MOVIEBOX_SESSION_KV, { token, expiresAtSeconds });
      return token;
    })().finally(() => {
      bootstrapPromise = null;
    });
  }
  return bootstrapPromise;
}

export async function getCachedAuthToken(env: SigningEnv): Promise<string | null> {
  const cached = await readTokenFromKv(env.MOVIEBOX_SESSION_KV);
  return cached && !isExpiringSoon(cached) ? cached.token : null;
}

export async function invalidateAuthToken(env: SigningEnv): Promise<void> {
  try {
    await env.MOVIEBOX_SESSION_KV.delete(KV_TOKEN_KEY);
  } catch (error) {
    console.warn('[Signing] Failed to invalidate KV token:', error);
  }
}

