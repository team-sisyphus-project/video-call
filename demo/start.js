/* eslint-disable no-console */

/**
 * MeetSpace demo launcher.
 *
 * Preview harnesses assign a port, probe it, and give up if nothing answers.
 * A jitsi-meet dev server cannot meet that: the asset deploy plus the first
 * webpack compile take minutes before anything binds.
 *
 * So this script binds the assigned port immediately and serves a "building"
 * page, starts the real dev server on an internal port, and proxies to it
 * (HTTP and WebSocket) as soon as it answers. The port is therefore live from
 * the first second and never goes down during the handover.
 *
 * Usage: node demo/start.js [--port N] [--strictPort] [--host H]
 * `--strictPort` is accepted and ignored; the port is always taken strictly.
 */

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Reads a `--flag value` or `--flag=value` pair out of argv.
 *
 * @param {string} name - The flag name, without dashes.
 * @param {string|undefined} fallback - Value when the flag is absent.
 * @returns {string|undefined} The flag value.
 */
function arg(name, fallback) {
    const argv = process.argv.slice(2);
    const exact = argv.indexOf(`--${name}`);

    if (exact !== -1 && argv[exact + 1] && !argv[exact + 1].startsWith('--')) {
        return argv[exact + 1];
    }

    const inline = argv.find(a => a.startsWith(`--${name}=`));

    if (inline) {
        return inline.slice(`--${name}=`.length);
    }

    return fallback;
}

/**
 * Resolves the port to bind.
 *
 * A harness may invoke this through `npm start`, and npm swallows unknown
 * flags: `npm start --port 5400` reaches the script as the bare argument
 * `5400`. So a lone numeric argument counts as the port too, and PORT is
 * honoured as an env fallback. Missing all three, 8080.
 *
 * @returns {number} The port to bind.
 */
function resolvePort() {
    const flag = arg('port');

    if (flag) {
        return Number(flag);
    }

    const bare = process.argv.slice(2).find(a => /^\d+$/.test(a));

    if (bare) {
        return Number(bare);
    }

    return Number(process.env.PORT || 8080);
}

const PORT = resolvePort();
const HOST = arg('host', process.env.HOST || '0.0.0.0');
const INTERNAL_PORT = Number(process.env.MEETSPACE_INTERNAL_PORT || PORT + 1);

let upstreamReady = false;

const BUILDING_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>MeetSpace is starting</title>
<meta http-equiv="refresh" content="5">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #17161d; color: #e7e5ee;
         font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .box { max-width: 34rem; padding: 2rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .75rem; }
  p { margin: 0 0 .5rem; color: #a9a5b8; }
  code { color: #f0a868; }
</style></head>
<body><div class="box">
  <h1>MeetSpace demo is building</h1>
  <p>The first webpack compile of jitsi-meet takes a few minutes. This page
     reloads every 5 seconds and swaps itself for the app once the dev server
     answers on port ${INTERNAL_PORT}.</p>
  <p>Follow along with <code>make demo</code> in a terminal for the compile log.</p>
</div></body></html>`;

/**
 * Forwards one HTTP request to the internal dev server.
 *
 * @param {Object} req - The incoming request.
 * @param {Object} res - The response to write to.
 * @returns {void}
 */
function proxyHttp(req, res) {
    const upstream = http.request(
        {
            host: '127.0.0.1',
            port: INTERNAL_PORT,
            method: req.method,
            path: req.url,
            headers: req.headers
        },
        upstreamRes => {
            res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
            upstreamRes.pipe(res);
        });

    upstream.on('error', () => {
        upstreamReady = false;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(BUILDING_PAGE);
    });

    req.pipe(upstream);
}

const server = http.createServer((req, res) => {
    if (!upstreamReady) {
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
        });

        return res.end(BUILDING_PAGE);
    }

    return proxyHttp(req, res);
});

// Hot module replacement and the proxied XMPP websocket both arrive as upgrades.
server.on('upgrade', (req, socket, head) => {
    if (!upstreamReady) {
        return socket.destroy();
    }

    const upstream = http.request({
        host: '127.0.0.1',
        port: INTERNAL_PORT,
        method: req.method,
        path: req.url,
        headers: req.headers
    });

    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
        const headers = Object.entries(upstreamRes.headers)
            .map(([ k, v ]) => `${k}: ${v}`)
            .join('\r\n');

        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n\r\n`);

        if (upstreamHead && upstreamHead.length) {
            upstreamSocket.unshift(upstreamHead);
        }

        upstreamSocket.pipe(socket);
        socket.pipe(upstreamSocket);
    });

    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());

    if (head && head.length) {
        req.unshift(head);
    }

    upstream.end();
});

server.listen(PORT, HOST, () => {
    console.log(`[meetspace] preview port ${HOST}:${PORT} is live`);
    console.log(`[meetspace] dev server will come up on 127.0.0.1:${INTERNAL_PORT}`);
    startDevServer();
});

server.on('error', err => {
    console.error(`[meetspace] cannot bind ${HOST}:${PORT}: ${err.message}`);
    process.exit(1);
});

/**
 * Polls the internal dev server until it answers, then flips the proxy on.
 *
 * @returns {void}
 */
function waitForUpstream() {
    const probe = net.connect(INTERNAL_PORT, '127.0.0.1');

    probe.on('connect', () => {
        probe.destroy();

        if (!upstreamReady) {
            upstreamReady = true;
            console.log('[meetspace] dev server is up, proxying');
        }
    });

    probe.on('error', () => {
        probe.destroy();
        setTimeout(waitForUpstream, 1000);
    });
}

/**
 * Deploys the static assets, generates the demo shell, then runs webpack.
 *
 * @returns {void}
 */
function startDevServer() {
    console.log('[meetspace] deploying assets');

    const assets = spawnSync('make', [ 'demo-assets' ], {
        cwd: ROOT,
        stdio: 'inherit'
    });

    if (assets.status !== 0) {
        console.error('[meetspace] asset deploy failed');
        process.exit(1);
    }

    const child = spawn(
        './node_modules/.bin/webpack',
        [ 'serve', '--mode', 'development' ],
        {
            cwd: ROOT,
            stdio: 'inherit',
            env: {
                ...process.env,
                MEETSPACE_DEMO: '1',
                MEETSPACE_HOST: '127.0.0.1',
                MEETSPACE_PORT: String(INTERNAL_PORT)
            }
        });

    child.on('exit', code => {
        console.error(`[meetspace] dev server exited with ${code}`);
        process.exit(code === null ? 1 : code);
    });

    const shutdown = () => {
        child.kill('SIGTERM');
        server.close();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    waitForUpstream();
}
