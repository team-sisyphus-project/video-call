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

## Setup

```bash
npm install
```

The install pulls the React Native toolchain too, so it takes a while and lands
around 1.3 GB in `node_modules`.

## Running it locally

**Demo mode, recommended for looking at the product:**

```bash
npm start
```

Or `make demo` to run webpack directly without the launcher. `npm start` binds
the port straight away and serves a build-progress page until the dev server is
compiled, which is what a preview harness needs; `make demo` gives you the raw
webpack output.

To run upstream's proxy-backed dev server instead:

```bash
npm run dev:upstream
```

Opens on http://localhost:8080 (plain HTTP on purpose: `http://localhost` is a
secure context, so camera access works without a certificate warning). The app
shell and configuration are served from this checkout, so the
welcome page, the prejoin screen with live camera preview, device selection,
virtual backgrounds and settings all work with no backend at all. Point it at a
Jitsi deployment and real meetings work too.

See [DEMO.md](DEMO.md) for the details and for how to attach a backend.

**Upstream dev mode:**

```bash
make dev
```

Same dev server, but `index.html` and `config.js` are proxied from a live Jitsi
deployment (`WEBPACK_DEV_SERVER_PROXY_TARGET`, default `https://alpha.jitsi.net`).
Nothing renders when that deployment is unreachable, which is why demo mode
exists. `npm start` no longer maps to this; use `npm run dev:upstream`.

**Production bundles:**

```bash
make
```

## Repository layout

Unchanged from upstream, plus:

```
demo/
  start.js               preview launcher, binds the port before webpack is ready
  build-index.js         generates index.demo.html from index.html
  config.js              demo Jitsi config, template
  interface_config.js    demo branding
harness.config.json      preview harness contract (app block, validation steps)
DEMO.md                  demo mode documentation
```

The only upstream files touched are `webpack.config.js` (a demo mode branch in
the dev server config plus host/port env overrides), `Makefile` (the `demo` and
`demo-assets` targets), `package.json` (three scripts) and `.gitignore`.

## Not done yet

- Branding beyond `APP_NAME` in the demo interface config
- A self hosted backend (Prosody, Jicofo, JVB), needed for meetings that do not
  depend on someone else's deployment
- Mobile (React Native) builds
