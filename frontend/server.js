const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const API_PROXY_TARGET = normalizeProxyTarget(
  process.env.API_PROXY_TARGET ||
  process.env.NEXT_PUBLIC_API_URL ||
  'http://127.0.0.1'
);

// One portal per process. PORTAL_ROLE decides which of the three the served page
// boots into; the page has no role switcher, so this is the only thing that sets it.
const PORTAL_ROLES = ['student', 'teacher', 'parent'];
const PORTAL_ROLE = PORTAL_ROLES.includes(process.env.PORTAL_ROLE)
  ? process.env.PORTAL_ROLE
  : 'student';

// The ports the *browser* should use to reach the sibling portals, which is not
// necessarily PORT: in Docker every portal listens on 3000 inside its container
// and is published on a different host port.
const PORTAL_PORTS = {
  student: Number(process.env.STUDENT_PORT) || 3000,
  teacher: Number(process.env.TEACHER_PORT) || 3001,
  parent: Number(process.env.PARENT_PORT) || 3002,
};

const PORTAL_CONFIG_RE = /(<script id="portal-config" type="application\/json">)[\s\S]*?(<\/script>)/;

// index.html ships with a valid default config block so it still opens straight
// from disk; here we swap in what this particular process is actually serving.
function renderIndex(html) {
  const config = JSON.stringify({ role: PORTAL_ROLE, ports: PORTAL_PORTS });
  return html.replace(PORTAL_CONFIG_RE, (_match, open, close) => `${open}${config}${close}`);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, `http://localhost:${PORT}`).pathname);
  if (urlPath.startsWith('/api/')) {
    proxyApiRequest(req, res);
    return;
  }

  const requestedPath = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(ROOT, requestedPath));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(ROOT, 'index.html'), (fallbackErr, fallbackData) => {
        if (fallbackErr) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        sendHtml(res, fallbackData);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html') {
      sendHtml(res, data);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

function sendHtml(res, data) {
  const body = renderIndex(data.toString('utf8'));
  res.writeHead(200, {
    'Content-Type': MIME_TYPES['.html'],
    'Content-Length': Buffer.byteLength(body),
    // The role is baked into the body, so a shared cache must not hand the
    // teacher portal's HTML to the parent portal.
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function normalizeProxyTarget(value) {
  const raw = String(value || '').trim() || 'http://127.0.0.1';
  const withoutApiSuffix = raw.endsWith('/api') ? raw.slice(0, -4) : raw;
  return withoutApiSuffix.replace(/\/+$/, '');
}

function proxyApiRequest(clientReq, clientRes) {
  let target;
  try {
    target = new URL(clientReq.url, API_PROXY_TARGET);
  } catch (error) {
    clientRes.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    clientRes.end(JSON.stringify({ error: 'Invalid API proxy target.' }));
    return;
  }

  const headers = {};
  for (const [name, value] of Object.entries(clientReq.headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers[name] = value;
  }
  headers.host = target.host;

  const requestOptions = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    method: clientReq.method,
    path: `${target.pathname}${target.search}`,
    headers,
  };

  const transport = target.protocol === 'https:' ? https : http;
  const proxyReq = transport.request(requestOptions, proxyRes => {
    const responseHeaders = {};
    for (const [name, value] of Object.entries(proxyRes.headers)) {
      if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) responseHeaders[name] = value;
    }
    clientRes.writeHead(proxyRes.statusCode || 502, responseHeaders);
    proxyRes.pipe(clientRes);
  });

  proxyReq.on('error', error => {
    if (clientRes.headersSent) {
      clientRes.destroy(error);
      return;
    }
    clientRes.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    clientRes.end(JSON.stringify({
      error: 'Backend API is not reachable from the frontend server.',
      target: API_PROXY_TARGET,
    }));
  });

  clientReq.pipe(proxyReq);
}

server.listen(PORT, HOST, () => {
  console.log(`[frontend:${PORTAL_ROLE}] portal running at http://${HOST}:${PORT}`);
  console.log(`[frontend:${PORTAL_ROLE}] proxying /api/* to ${API_PROXY_TARGET}`);
});
