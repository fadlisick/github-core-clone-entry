// Shared HTTP helpers for the forge: JSON replies, auth, body reading.
// Every REST reply carries a non-empty X-GitHub-Request-Id and JSON content-type.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER_LOGIN, type Store } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

export function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

export function authOk(req: IncomingMessage): boolean {
  const expected = expectedToken();
  if (expected === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${expected}`;
}

export function sendJson(store: Store, res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': store.nextRequestId(),
    ...headers,
  });
  res.end(text);
}

export function sendBuffer(store: Store, res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': store.nextRequestId(),
    ...headers,
  });
  res.end(body);
}

export function jsonError(store: Store, res: ServerResponse, status: number, message: string): void {
  sendJson(store, res, status, { message });
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body. Empty body -> {}. Malformed -> null. */
export function parseJson(buf: Buffer): unknown {
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function viewerUser(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: 1000,
    node_id: 'VXNlcjoxMDAw',
    avatar_url: '',
    type: 'User',
    site_admin: false,
    name: 'ada iversen',
    email: 'adaiversen@example.invalid',
    html_url: `https://example.invalid/${VIEWER_LOGIN}`,
    url: `/api/v3/users/${VIEWER_LOGIN}`,
  };
}

export function linkHeader(base: string, page: number, perPage: number, total: number): string {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const parts: string[] = [];
  if (page < lastPage) parts.push(`<${base}?page=${page + 1}&per_page=${perPage}>; rel="next"`);
  if (page > 1) parts.push(`<${base}?page=${page - 1}&per_page=${perPage}>; rel="prev"`);
  parts.push(`<${base}?page=1&per_page=${perPage}>; rel="first"`);
  parts.push(`<${base}?page=${lastPage}&per_page=${perPage}>; rel="last"`);
  return parts.join(', ');
}
