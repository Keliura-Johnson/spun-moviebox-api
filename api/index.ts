
import worker from '../src/index.js';

interface VercelRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface VercelResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

interface MemoryEntry {
  value: string;
  expiresAt: number | null;
}

const tokenCache = new Map<string, MemoryEntry>();

const sessionKV = {
  async get(key: string): Promise<string | null> {
    const entry = tokenCache.get(key);

    if (!entry) return null;

    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      tokenCache.delete(key);
      return null;
    }

    return entry.value;
  },

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void> {
    const ttl = options?.expirationTtl;

    tokenCache.set(key, {
      value,
      expiresAt:
        typeof ttl === 'number' && ttl > 0
          ? Date.now() + ttl * 1000
          : null,
    });
  },

  async delete(key: string): Promise<void> {
    tokenCache.delete(key);
  },
};

function firstHeader(
  value: string | string[] | undefined
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  try {
    const host =
      firstHeader(req.headers['x-forwarded-host']) ??
      firstHeader(req.headers.host);

    if (!host) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Missing request host' }));
      return;
    }

    const protocol =
      firstHeader(req.headers['x-forwarded-proto']) ?? 'https';

    const url = new URL(req.url ?? '/', `${protocol}://${host}`);

    const headers = new Headers();

    for (const [key, value] of Object.entries(req.headers)) {
      if (
        value === undefined ||
        ['host', 'connection', 'content-length'].includes(key.toLowerCase())
      ) {
        continue;
      }

      headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }

    let body: string | undefined;

    if (req.body !== undefined && req.body !== null) {
      body =
        typeof req.body === 'string'
          ? req.body
          : JSON.stringify(req.body);
    }

    const method = (req.method ?? 'GET').toUpperCase();

    const request = new Request(url.toString(), {
      method,
      headers,
      ...(method !== 'GET' && method !== 'HEAD' && body !== undefined
        ? { body }
        : {}),
    });

    const env = {
      MOVIEBOX_SECRET: process.env.MOVIEBOX_SECRET ?? '',
      NIGERIA_IP: process.env.NIGERIA_IP,
      RELAY_URL: process.env.RELAY_URL ?? '',
      RELAY_SECRET: process.env.RELAY_SECRET ?? '',
      MOVIEBOX_SESSION_KV: sessionKV,
    };

    const response = await worker.fetch(
      request,
      env as Parameters<typeof worker.fetch>[1]
    );

    res.statusCode = response.status;

    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    res.end(await response.text());
  } catch (error) {
    console.error('[Vercel API Error]', error);

    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}
