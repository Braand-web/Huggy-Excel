import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './api.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const staticRoot = join(root, 'public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const env = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY };

createServer(async (req, res) => {
  try {
    const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const apiResponse = await handleApi(new Request(`http://${req.headers.host || '127.0.0.1:4173'}${req.url}`, { method: req.method, headers: req.headers, body: hasBody ? req : undefined, ...(hasBody ? { duplex: 'half' } : {}) }), env);
    if (apiResponse) { res.writeHead(apiResponse.status, Object.fromEntries(apiResponse.headers)); res.end(Buffer.from(await apiResponse.arrayBuffer())); return; }
  } catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); return; }
  const requested = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = normalize(join(staticRoot, requested));
  if (!file.startsWith(staticRoot)) { res.writeHead(403); res.end('Forbidden'); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}).listen(Number(process.env.PORT || 4173), '127.0.0.1', () => console.log(`Huggy Excel listening on http://127.0.0.1:${process.env.PORT || 4173}`));
