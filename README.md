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

## Running it locally

### From a clean checkout

Three commands, in this order, on a machine with nothing but Node and make:

```bash
npm install            # dependencies + postinstall, a few minutes
npm run build          # webpack production bundles + asset deploy into libs/
PORT=5400 npm start    # http://localhost:5400
```

Then check it answers:

```bash
curl -sI http://127.0.0.1:5400/          # 200, content-type: text/html
curl -sI http://127.0.0.1:5400/StandUp   # 200, the same shell: rooms are paths
```

That is the whole green-field path, and it is what a deployment and the preview
run. There is no fourth step:

- **No database and no cache.** Nothing to migrate, nothing to seed. The
  platform's `DATABASE_URL` and `REDIS_URL` are ignored if they are injected —
  the app never reads them. Conference state lives in the signalling backend and
  in the browsers of the people in the room.
- **No accounts, dummy or otherwise.** There is no sign up, no login and no
  seeded user to hand a reviewer. Anyone with the URL opens a room, and the room
  exists because someone opened it.

`npm install` also runs `postinstall`, which applies the `patches/` overrides and
prepares the React Native side (`jetifier`, autolinking metadata). Those steps
are pure Node and succeed without an Android or iOS toolchain installed, so a
web-only checkout is unaffected — it only pays the minutes. The install pulls the
React Native toolchain too, so it lands around 1.3 GB in `node_modules`.

`.npmrc` asks npm for dev dependencies explicitly: the build toolchain (webpack,
sass, patch-package) lives in `devDependencies`, and a host that exports
`NODE_ENV=production` would otherwise skip them and break both the install and
the build.

### What `npm start` serves

`npm start` (`node server/index.js`) serves everything on one plain HTTP port:
the built bundles and assets, `config.js` and `interface_config.js` generated
from the environment, and the application shell for every other path, so room
URLs like `/StandUp` work. It binds `PORT` on `0.0.0.0` and never redirects to
https, because TLS is terminated in front of it. It refuses to start when the
build output is missing, rather than serving a broken shell.

Without a reachable backend the welcome page, the prejoin screen with camera
preview and the settings surfaces still load; joining a meeting needs the
backend.

### When the preview does not come up

The preview runs those same three steps as named stages — `install`, `build`,
`start` — through `scripts/preview.js`, which is what `preview.toml` and
`harness.config.json` point at: `npm run preview:build` is install plus build,
`npm run preview:start` is start. The commands underneath are unchanged and
their output is streamed through untouched. What the runner adds is a name for
the stage that stopped.

A failed run prints exactly one line of this shape:

```
[preview] STAGE=build STATUS=failed
```

Grep the log for `[preview] STAGE=` and read the stage token. That token is the
classification, and there is never more than one per run:

- `install` — `npm install` failed. It also runs `postinstall` (patch-package,
  jetify, Android autolinking), so a failure there stops the install.
- `build` — `npm run build` failed. That is webpack plus the asset deploy; a
  kill by signal, printed as `exit=137 signal=SIGKILL`, is the machine running
  out of memory rather than a compile error.
- `start` — `npm start` did not bring the server up.

Under the marker come the command, the exit status, one line of what that stage
failing usually means, and the last lines of that stage's own output
(`PREVIEW_TAIL_LINES` sets how many, default 20). Stages that succeed report as
`[preview] stage build: ok in 84s` and never use the marker form.

The server classifies its own startup on top of that, under its own prefix so
the runner's one verdict per run stays the only `[preview] STAGE=` line:

```
[meetspace] STAGE=start STATUS=ready url=http://0.0.0.0:5400
[meetspace] STAGE=start STATUS=failed REASON=build-output-missing
```

`REASON` is one of `build-output-missing` (the build produced nothing to serve;
the missing files are listed on the next line), `port-invalid`,
`port-unavailable` or `internal`, and the two lines following it are the failure
in the server's own words and what that reason means for the reader. The ready
line is what tells "the application never started" apart from "it started and
the readiness probe is looking somewhere else": a probe that times out against a
process that printed it is the second.

### Configuration

Everything is an environment variable and everything is optional. No secrets are
involved, so there is nothing to keep out of the repository — and nothing here
should ever be committed as a value.

| Variable | Default | Read by | What it does |
| --- | --- | --- | --- |
| `PORT` | `8080` | `npm start`, `npm run demo` | Port to listen on. The only variable a preview has to set. |
| `HOST` | `0.0.0.0` | `npm run demo` | Interface the demo launcher binds. `npm start` always binds `0.0.0.0` and takes no override. |
| `MEETSPACE_BACKEND` | `alpha.jitsi.net` | `npm start`, `make demo` | Signalling deployment the client connects to. A bare host or a URL; the host is what ends up in the generated `config.js`. |
| `MEETSPACE_APP_NAME` | unset, keeps `interface_config.js` | `npm start` | Application name shown in the UI, so a deployment can be renamed without a rebuild. |
| `WEBPACK_DEV_SERVER_PROXY_TARGET` | `https://alpha.jitsi.net` | `make demo`, `make dev` | Where the dev server forwards signalling, and under `make dev` the shell and config as well. `npm start` does not proxy and does not read it. |
| `MEETSPACE_HTTPS` | unset, plain HTTP | `make demo` | Serve demo mode over HTTPS instead. |
| `MEETSPACE_HOST` / `MEETSPACE_PORT` | `localhost` / webpack's default | `make demo`, `make dev` | Interface and port for webpack's own dev server, when running it directly rather than through the launcher. |

An invalid `PORT` or `MEETSPACE_BACKEND` stops the process at startup with the
offending value in the message. Neither is guessed at.

Pointing the production server at your own deployment:

```bash
PORT=5400 MEETSPACE_BACKEND=meet.example.com npm start
```

### Demo mode

The webpack dev server with a build-progress page, for working on the client:

```bash
npm run demo
```

Or `make demo` to run webpack directly without the launcher. `npm run demo`
binds the port straight away and serves a build-progress page until the dev
server has compiled; `make demo` gives you the raw webpack output.

Demo mode opens on http://localhost:8080 (plain HTTP on purpose:
`http://localhost` is a secure context, so camera access works without a
certificate warning). The app shell and configuration are served from this
checkout, so the welcome page, the prejoin screen with live camera preview,
device selection, virtual backgrounds and settings all work with no backend at
all. Point it at a Jitsi deployment and real meetings work too.

Demo mode is a development convenience, started by hand. It is not the path a
deployment or the preview takes — that is `npm run build` then `npm start`, as
declared in `preview.toml`. See [DEMO.md](DEMO.md) for the details and for how to
attach a backend.

### Upstream dev mode

```bash
npm run dev:upstream    # or: make dev
```

The same dev server, but `index.html` and `config.js` are proxied from a live
Jitsi deployment (`WEBPACK_DEV_SERVER_PROXY_TARGET`, default
`https://alpha.jitsi.net`). Nothing renders when that deployment is unreachable,
which is why demo mode exists.

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
