import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type http from 'node:http';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json'
};

function noCacheFile(name: string): boolean {
  return (
    name === 'index.html' ||
    name === 'sw.js' ||
    name === 'registerSW.js' ||
    name === 'manifest.webmanifest'
  );
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export async function serveStaticWeb(input: {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  root: string;
  prefix?: string;
  spaFallback?: boolean;
}): Promise<boolean> {
  const method = input.request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') return false;

  const prefix = input.prefix ?? '/';
  const url = new URL(
    input.request.url ?? '/',
    `http://${input.request.headers.host ?? 'localhost'}`
  );

  const matches =
    prefix === '/'
      ? url.pathname === '/' ||
        url.pathname.startsWith('/assets/') ||
        url.pathname === '/manifest.webmanifest' ||
        url.pathname === '/sw.js' ||
        url.pathname === '/registerSW.js' ||
        url.pathname.startsWith('/workbox-')
      : url.pathname === prefix ||
        url.pathname === `${prefix}/` ||
        url.pathname.startsWith(`${prefix}/`);

  if (!matches) return false;

  let relative =
    prefix === '/'
      ? url.pathname.replace(/^\/+/, '')
      : url.pathname.slice(prefix.length).replace(/^\/+/, '');

  if (!relative) relative = 'index.html';

  try {
    relative = decodeURIComponent(relative);
  } catch {
    return false;
  }

  if (
    relative.split('/').some(part => part === '..') ||
    path.isAbsolute(relative)
  ) {
    return false;
  }

  const root = path.resolve(input.root);
  let target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return false;
  }

  if (!(await fileExists(target))) {
    const extension = path.extname(relative);
    if (input.spaFallback && !extension) {
      target = path.join(root, 'index.html');
    } else {
      return false;
    }
  }

  if (!(await fileExists(target))) return false;

  const data = await readFile(target);
  const ext = path.extname(target).toLowerCase();
  const basename = path.basename(target);

  input.response.statusCode = 200;
  input.response.setHeader(
    'content-type',
    MIME_TYPES[ext] ?? 'application/octet-stream'
  );
  input.response.setHeader(
    'cache-control',
    noCacheFile(basename)
      ? 'no-cache,no-store,must-revalidate'
      : 'public,max-age=31536000,immutable'
  );
  input.response.setHeader('x-content-type-options', 'nosniff');

  if (method === 'HEAD') {
    input.response.end();
  } else {
    input.response.end(data);
  }
  return true;
}
