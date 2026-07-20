import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const requestedPort = Number(process.env.TELEVIEW_PORT || process.argv[2] || 4173);
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  const decodedPath = decodeURIComponent(url.pathname);
  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
  const candidate = normalize(join(root, relativePath));

  if (!candidate.startsWith(`${root}/`) || !existsSync(candidate) || statSync(candidate).isDirectory()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': mimeTypes[extname(candidate).toLowerCase()] || 'application/octet-stream',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  createReadStream(candidate).pipe(response);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${requestedPort} is already in use. Try: npm start -- 4174`);
    process.exitCode = 1;
    return;
  }
  throw error;
});

server.listen(requestedPort, '127.0.0.1', () => {
  console.log(`Teleview is ready at http://127.0.0.1:${requestedPort}`);
  console.log('Press Ctrl+C to stop. Your archive stays in this browser.');
});
