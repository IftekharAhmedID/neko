import http from 'http';
import { readFile } from 'fs/promises';
import net from 'net';
import { URL } from 'url';

const CONFIG_PATH = process.env.TRANSLUCID_CONFIG_PATH || '/opt/translucid/config.json';
const CDP_HTTP_URL = process.env.CDP_HTTP_URL || 'http://127.0.0.1:9222';
const PORT = Number(process.env.BROWSER_USE_CDP_BRIDGE_PORT || 3212);
const MAX_BODY_BYTES = Number(process.env.BROWSER_USE_CDP_BRIDGE_MAX_BODY_BYTES || 10 * 1024 * 1024);

let configCache = null;

async function readConfig() {
  if (configCache) return configCache;
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    configCache = {
      sessionId: parsed.sessionId || '',
      cdpBridgeToken: parsed.cdpBridgeToken || process.env.TRANSLUCID_CDP_BRIDGE_TOKEN || '',
    };
  } catch {
    configCache = {
      sessionId: '',
      cdpBridgeToken: process.env.TRANSLUCID_CDP_BRIDGE_TOKEN || '',
    };
  }
  return configCache;
}

async function isAuthorized(req) {
  const config = await readConfig();
  if (!config.cdpBridgeToken) return false;
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const token = req.headers['x-cdp-bridge-token'] || url.searchParams.get('token');
  return token === config.cdpBridgeToken;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function proxyHttp(req, res) {
  if (!(await isAuthorized(req))) {
    sendJson(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }
  const incoming = new URL(req.url || '/', 'http://127.0.0.1');
  const upstream = new URL(incoming.pathname + incoming.search, CDP_HTTP_URL);
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
  const response = await fetch(upstream, {
    method: req.method,
    headers: { 'content-type': req.headers['content-type'] || 'application/json' },
    body,
  });
  const contentType = response.headers.get('content-type') || 'application/json';
  const buffer = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(buffer);
}

function parseHttpHeader(buffer) {
  const text = buffer.toString('utf8');
  const end = text.indexOf('\r\n\r\n');
  if (end < 0) return null;
  const head = text.slice(0, end);
  const lines = head.split('\r\n');
  const [method, path] = lines[0].split(' ');
  const headers = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':');
    if (idx > 0) headers[line.slice(0, idx).toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { method, path, headers };
}

const server = http.createServer((req, res) => {
  proxyHttp(req, res).catch((error) => {
    sendJson(res, 500, { ok: false, error: error.message });
  });
});

server.on('upgrade', async (req, socket, head) => {
  try {
    if (!(await isAuthorized(req))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const incoming = new URL(req.url || '/', 'http://127.0.0.1');
    if (!incoming.pathname.startsWith('/devtools/')) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const upstreamBase = new URL(CDP_HTTP_URL);
    const upstream = net.connect(Number(upstreamBase.port || 9222), upstreamBase.hostname || '127.0.0.1');
    upstream.on('connect', () => {
      const rawPath = incoming.pathname;
      const lines = [
        `GET ${rawPath} HTTP/1.1`,
        `Host: ${upstreamBase.host}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        `Sec-WebSocket-Key: ${req.headers['sec-websocket-key']}`,
        `Sec-WebSocket-Version: ${req.headers['sec-websocket-version'] || '13'}`,
      ];
      if (req.headers['sec-websocket-protocol']) lines.push(`Sec-WebSocket-Protocol: ${req.headers['sec-websocket-protocol']}`);
      if (req.headers['sec-websocket-extensions']) lines.push(`Sec-WebSocket-Extensions: ${req.headers['sec-websocket-extensions']}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  } catch {
    socket.destroy();
  }
});

server.listen(PORT, '0.0.0.0', async () => {
  const config = await readConfig();
  console.log(`[BrowserUseCDPBridge] listening on 0.0.0.0:${PORT} session=${String(config.sessionId).slice(0, 8)}`);
});
