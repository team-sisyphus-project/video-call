# MeetSpace

A private fork of [jitsi-meet](https://github.com/jitsi/jitsi-meet): browser
based video meetings, WebRTC, no installs for participants.

This repository is at the "fork it and get it running locally" stage. Nothing
has been rebranded or restructured beyond what demo mode needs.

- Upstream: `jitsi/jitsi-meet`, snapshot taken 2026-09-04
- Upstream README: [README.upstream.md](README.upstream.md)
- Licence: Apache 2.0 (unchanged, see [LICENSE](LICENSE))

## Requirements

- Node.js 24 (tested on 24.20.0) and npm 11
- macOS or Linux, GNU make

## From a clean checkout

Three commands, in this order, on a machine with nothing but Node and make:

```bash
npm install            # dependencies + postinstall, a few minutes
npm run build          # webpack production bundles + asset deploy into libs/
PORT=5400 npm start    # http://localhost:5400
```

Then check it answers:

```bash
curl -sI http://127.0.0.1:5400/     # 200, content-type: text/html
```

There is no database and no cache, so there is nothing to migrate and nothing to
seed. There are no accounts either, dummy or otherwise: anyone with the URL opens
a room, and the room exists because someone opened it.

`npm install` also runs `postinstall`, which applies the `patches/` overrides and
prepares the React Native side (`jetifier`, autolinking metadata). Those steps
are pure Node and succeed without an Android or iOS toolchain installed, so a
web-only checkout is unaffected — it only pays the minutes. The install pulls the
React Native toolchain too, so it lands around 1.3 GB in `node_modules`.

`.npmrc` asks npm for dev dependencies explicitly: the build toolchain (webpack,
sass, patch-package) lives in `devDependencies`, and a host that exports
`NODE_ENV=production` would otherwise skip them and break both the install and
the build.

## Running it locally

**The production build above is what a deployment and the preview run.**

`npm start` (`node server/index.js`) serves everything on one plain HTTP port:
the built bundles and assets, `config.js` and `interface_config.js` generated
from the environment, and the application shell for every other path, so room
URLs like `/StandUp` work. It binds `PORT` (default 8080) on `0.0.0.0` and never
redirects to https, because TLS is terminated in front of it. It refuses to start
when the build output is missing rather than serving a broken shell.

Configuration, all optional:

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on |
| `MEETSPACE_BACKEND` | `alpha.jitsi.net` | Signalling deployment the client connects to |
| `MEETSPACE_APP_NAME` | unset, keeps `interface_config.js` | Application name shown in the UI |

Without a reachable backend the welcome page, the prejoin screen with camera
preview and the settings surfaces still load; joining a meeting needs the
backend.

**Demo mode, the webpack dev server with a build-progress page:**

```bash
npm run demo
```

Or `make demo` to run webpack directly without the launcher. `npm run demo`
binds the port straight away and serves a build-progress page until the dev
server is compiled; `make demo` gives you the raw webpack output.

To run upstream's proxy-backed dev server instead:

```bash
npm run dev:upstream
```

Demo mode opens on http://localhost:8080 (plain HTTP on purpose:
`http://localhost` is a secure context, so camera access works without a
certificate warning). The app shell and configuration are served from this
checkout, so the welcome page, the prejoin screen with live camera preview,
device selection, virtual backgrounds and settings all work with no backend at
all. Point it at a Jitsi deployment and real meetings work too.

See [DEMO.md](DEMO.md) for the details and for how to attach a backend.

**Upstream dev mode:**

```bash
make dev
```

Same dev server, but `index.html` and `config.js` are proxied from a live Jitsi
deployment (`WEBPACK_DEV_SERVER_PROXY_TARGET`, default `https://alpha.jitsi.net`).
Nothing renders when that deployment is unreachable, which is why demo mode
exists.

## Repository layout

Unchanged from upstream, plus:

```
server/
  index.js               production server: binds $PORT, serves assets + shell
  shell.js               resolves the SSI includes in index.html
  runtime-config.js      generates config.js / interface_config.js from the env
  static.js              request path -> file on disk, content types
  server.test.js         tests, `npm run test:server`
demo/
  start.js               preview launcher, binds the port before webpack is ready
  build-index.js         generates index.demo.html from index.html
  config.js              demo Jitsi config, template
  interface_config.js    demo branding
preview.toml             local preview contract: build, start, $PORT
harness.config.json      preview harness contract (app block, validation steps)
DEMO.md                  demo mode documentation
```

The only upstream files touched are `webpack.config.js` (a demo mode branch in
the dev server config plus host/port env overrides), `Makefile` (the `demo` and
`demo-assets` targets), `package.json` (scripts), `.npmrc` (`include=dev`) and
`.gitignore` (its `tsconfig.json` rule is anchored to the root, so the checked-in
`tests/tsconfig.json` that the tests' eslint config parses with survives a clone).

## Not done yet

- Branding beyond `APP_NAME` in the demo interface config
- A self hosted backend (Prosody, Jicofo, JVB), needed for meetings that do not
  depend on someone else's deployment
- Mobile (React Native) builds
