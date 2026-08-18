import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Dev-only middleware that lets the running game write a rendered frame to disk.
 * This is the backbone of the review loop: a reviewer drives the game from the
 * console, POSTs the frame here, and then opens the PNG — always looking at the
 * real render rather than a description of it.
 */
function screenshotEndpoint() {
  return {
    name: 'screenshot-endpoint',
    configureServer(server) {
      const dir = path.resolve(process.cwd(), 'shots');
      server.middlewares.use('/__shot', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end('POST only'); }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try {
            fs.mkdirSync(dir, { recursive: true });
            const url = new URL(req.url, 'http://x');
            const raw = (url.searchParams.get('name') || 'shot').replace(/[^a-z0-9_.-]/gi, '_');
            const b64 = body.replace(/^data:image\/\w+;base64,/, '');
            const ext = body.startsWith('data:image/png') ? 'png' : 'jpg';
            const file = path.join(dir, `${raw}.${ext}`);
            fs.writeFileSync(file, Buffer.from(b64, 'base64'));
            res.setHeader('content-type', 'text/plain');
            res.end(file);
          } catch (e) {
            res.statusCode = 500;
            res.end(String(e));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [screenshotEndpoint()],
  server: { open: false, host: '127.0.0.1' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
