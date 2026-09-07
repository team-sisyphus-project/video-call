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

That is the whole green-field path and what a deployment runs. The preview runs
the same three steps with less work in two of them, described below. There is no
fourth step:

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
web-only checkout is unaffected — it only pays the minutes. The preview does not
pay them: it sets `MEETSPACE_SKIP_MOBILE=1` and those steps are skipped. The
install pulls the React Native toolchain either way, so it lands around 1.3 GB
in `node_modules`.

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

### What the preview does differently

The preview runs the same three steps on a machine with a fraction of the
memory and the minutes a release build assumes. Two of the steps are lighter
for it. Nothing the served page pulls is left out, so what comes up is the
application and not a reduced one.

`install` runs with `MEETSPACE_SKIP_MOBILE=1`. `postinstall` then applies the
`patches/` overrides and stops, skipping `jetify`, `android-clean-cmake-cache`
and `android-autolinking` — the three steps that exist for the React Native
side, which a web preview never builds. `patch-package` is never skipped,
because the bundles are compiled from the patched sources. The install says
what it did and did not do:

```
[preview] stage install: mobile install steps opted out (MEETSPACE_SKIP_MOBILE=1)
[postinstall] STAGE=install STATUS=ok ran=patch-package skipped=jetify,android-clean-cmake-cache,android-autolinking
```

`build` runs `npm run build:preview` (`make preview`) instead of `npm run build`
(`make all`). That sets `MEETSPACE_PREVIEW=1` for webpack and sizes the V8
old-space heap to the machine — 75% of total memory, capped at 8192 MB and
floored at 2048 MB — rather than asking for the fixed 8 GB `make all` asks for
on every machine. The number and the reason for it are both in the log:

```
[preview] stage build: preview build profile, heap sized to this machine (make preview)
[heap-size] stage build: heap 6144 MB of 8192 MB total (75% share, cap 8192, floor 2048)
[webpack] stage build: preview profile, 6 of 9 bundles, no source maps (dropped: alwaysontop, documentpip, close3)
```

Under `MEETSPACE_PREVIEW=1` three bundles are absent from `build/` and from the
deployed `libs/`, and so are all source maps:

- `alwaysontop.min.js` — the always-on-top window
- `documentpip.min.js` — its document picture-in-picture variant
- `close3.min.js` — the third-party close page

All three are reachable only from surfaces a preview never opens. The six that
are built are the ones the page pulls: `app.bundle.min.js`,
`external_api.min.js` and the four workers (`face-landmarks-worker`,
`noise-suppressor-worklet`, `screenshot-capture-worker`,
`vb-inference-worker`). The list lives in `PREVIEW_ENTRIES` in
`webpack.config.js`, and a name in it that no longer matches an entry fails the
build instead of quietly shrinking it.

`npm run build` is untouched: it still builds all nine bundles with source maps
and asks for the same heap it always did. Run that one, not `build:preview`,
when a missing bundle or a stack trace against a source map is what you are
working on.

### When the preview does not come up

The preview runs those same three steps as named stages — `install`, `build`,
`start` — through `scripts/preview.js`, which is what `preview.toml` and
`harness.config.json` point at: `npm run preview:build` is install plus build,
`npm run preview:start` is start. The commands underneath are the ones above,
with the preview's own switches, and their output is streamed through
untouched. What the runner adds is a name for the stage that stopped.

A failed run prints exactly one line of this shape:

```
[preview] STAGE=build STATUS=failed
```

Grep the log for `[preview] STAGE=` and read the stage token. That token is the
classification, and there is never more than one per run:

- `install` — `npm install` failed. It also runs `postinstall`, which under the
  preview is `patch-package` alone, so a failure there stops the install. The
  `[postinstall]` line names the step that failed.
- `build` — `npm run build:preview` failed. That is webpack under the preview
  profile plus the asset deploy; a kill by signal, printed as
  `exit=137 signal=SIGKILL`, is the machine running out of memory rather than a
  compile error, and the heap that build asked for is on the `[heap-size]` line
  above it.
- `start` — `npm start` did not bring the server up, or was stopped before it
  reported itself ready. The runner reads that readiness out of the server's
  own output, so a preview the platform reaps on a readiness timeout is
  reported as a failed `start` rather than as a clean shutdown.

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

Under that line come the same failure in the server's own words and one line of
what the reason means for the reader. `REASON` is one of five tokens:

- `build-output-missing` — the build left nothing to serve, so no socket was
  opened. The line under it names every missing path with a count
  (`missing 3 of 9 build outputs: ...`), and counts a zero-byte file or an empty
  directory as missing, because that is the shape a killed deploy leaves. This
  is the build stage failing late, not the server.
- `port-invalid` — `PORT` is not an integer between 1 and 65535. No socket was
  opened here either.
- `port-unavailable` — the port could not be bound: taken, not permitted, or
  not an address on this machine. Nothing is listening, so a readiness check
  against it can only time out.
- `readiness-check-failed` — the far side of `build-output-missing`: the build
  output is there and the port is open, but the application did not come out
  over it. The line under it is what the check actually got — one of
  `GET http://127.0.0.1:5400/ answered 500, expected 200`,
  `... did not answer within 5000ms` and `... failed: connect ECONNREFUSED`.
  The status code or the timeout value is the part that says where to look: a
  500 means the cause is further up this log, a timeout means the process
  itself is stuck, and a refused connection means the port being watched is not
  the one the application is on.
- `internal` — the server could not classify the failure. The raw message is
  all of it.

The ready line means served, not merely listening. Before writing it the server
asks itself for `/` on the loopback address and requires a 200 within 5000 ms —
the same request a readiness check makes, so the line is evidence that the
application answered one. A run prints either `STATUS=ready` or
`STATUS=failed`, never both. That is what tells "the application never started"
apart from "it started and the readiness check is looking somewhere else": a
check that times out against a process that printed the ready line is the
second, and the port, host or path it is aimed at is what to look at.

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
deployment or the preview takes — that is `npm run build` (`npm run
build:preview` for the preview) then `npm start`, as declared in
`preview.toml`. See [DEMO.md](DEMO.md) for the details and for how to attach a
backend.

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
