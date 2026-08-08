// newsletter/preview-server.js — DEV ONLY. Serves the sample newsletter at / for visual
// preview, re-rendering (and hot-reloading the newsletter modules) on every request so
// edits show on browser reload. Not used in production.
const http = require('http');

const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  try {
    // Drop cached newsletter modules so source edits take effect on reload.
    for (const k of Object.keys(require.cache)) {
      if (k.includes('newsletter') || k.includes('generate-sample-template')) delete require.cache[k];
    }
    const { buildFromSample } = require('./from-sample');
    const { renderNewsletter } = require('./render');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderNewsletter(buildFromSample()));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Render error:\n' + e.stack);
  }
}).listen(PORT, () => console.log(`Newsletter preview on http://localhost:${PORT}`));
