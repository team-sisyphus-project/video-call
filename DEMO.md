# MeetSpace demo mode

Demo mode exists so the product can be opened, explored and actually used
locally, without standing up Prosody, Jicofo and a videobridge first.

```bash
make demo
```

Then open **http://localhost:8080**.

Demo mode serves over plain HTTP on purpose: `http://localhost` counts as a
secure context, so camera and microphone access still works, and there is no
self signed certificate warning to click through. Set `MEETSPACE_HTTPS=1` to
serve over HTTPS instead (upstream `make dev` is unchanged and stays HTTPS).

## What demo mode changes

Upstream `make dev` serves only the JavaScript bundles and static assets from
your checkout and proxies everything else, `index.html` and `config.js`
included, to a live Jitsi deployment. Nothing renders when that deployment is
unreachable.

`make demo` serves the application shell locally instead:

| Request | `make dev` | `make demo` |
| --- | --- | --- |
| `/`, `/RoomName` | proxied | `index.demo.html` from this checkout |
| `/config.js` | proxied | `demo/config.runtime.js` |
| `/interface_config.js` | proxied | `demo/interface_config.js` |
| bundles, css, images, lang, sounds | local | local |
| `/demo/*` | n/a | local |
| `/http-bind`, `/xmpp-websocket`, `/colibri-ws` | proxied | proxied |

Signalling stays on the proxy on purpose. The browser then talks to a single
origin (`localhost:8080`), which avoids the cross origin restrictions a public
Jitsi deployment applies to XMPP connections made from another host.

## Two levels of demo

**Offline, no backend at all.** The welcome page, room creation, the prejoin
screen with live camera and microphone preview, device selection, background
blur and virtual backgrounds, settings, language switching and the
pre-conference toolbar all load and work. This is the "look around the product"
path and needs no network.

**Online, with a backend.** Joining a room opens a real conference through the
proxied deployment. Set the backend explicitly:

```bash
MEETSPACE_BACKEND=meet.example.com WEBPACK_DEV_SERVER_PROXY_TARGET=https://meet.example.com make demo
```

Both variables must point at the same deployment: `MEETSPACE_BACKEND` is the
XMPP domain written into the demo config, `WEBPACK_DEV_SERVER_PROXY_TARGET` is
where the dev server forwards signalling. The default is `alpha.jitsi.net`,
which is Jitsi's own public development deployment and may require sign in or
be unavailable; it is a convenience default, not a dependency.

To run against a backend you control, deploy Jitsi with
[docker-jitsi-meet](https://github.com/jitsi/docker-jitsi-meet) and point both
variables at it.

## Demo config

`demo/config.js` is a template. `demo/build-index.js` substitutes the backend
domain into it and writes `demo/config.runtime.js`, which is what the browser
loads. Edit the template, not the generated file.

The demo config deliberately turns off third party requests, analytics and
rtcstats, enables the welcome page and forces the prejoin screen on, so a first
time visitor sees the camera preview before anything connects.

`demo/interface_config.js` carries the demo branding (`APP_NAME`,
`PROVIDER_NAME`, watermark off). Production branding is a separate task.

## Regenerating the shell

`index.demo.html` is generated from `index.html` on every `make demo`. If you
edit `index.html`, rerun:

```bash
node demo/build-index.js
```

Both `index.demo.html` and `demo/config.runtime.js` are generated and ignored by
git.

## Verified locally

On 2026-09-04, `make demo` on macOS with Node 24.20.0:

- welcome page, room creation, prejoin screen and the settings dialog (audio,
  video, backgrounds, notifications, profile, shortcuts) all render from local
  files only, no request leaves the machine except the proxied signalling
- `POST /http-bind` through the proxy opens a real XMPP session on the backend,
  so joining a room reaches a live deployment
- one harmless 404: `/lang/countries-ko.json`, which upstream does not ship

The welcome page still carries upstream Jitsi artwork and copy. Only `APP_NAME`
and `PROVIDER_NAME` are changed, which is why the browser tab reads MeetSpace
while the page header does not. Branding is a separate task.

## Running under a preview harness

`npm run demo` runs `demo/start.js`, which exists because a jitsi-meet dev server
cannot satisfy a readiness probe on its own: the asset deploy plus the first
webpack compile take minutes before anything binds a port, so the harness gives
up with `port_not_bound`.

The launcher instead:

1. binds the assigned port on `0.0.0.0` within about a second and answers every
   request with a build-progress page that reloads itself every 5 seconds
2. runs `make demo-assets` (sass, wasm and model copies, demo shell generation)
3. starts webpack on an internal port (assigned port + 1)
4. proxies HTTP and WebSocket upgrades to it once it answers

The port therefore responds from the first second and never goes down during
the handover. HMR and the proxied XMPP socket both survive it.

```bash
npm run demo                      # port 8080
node demo/start.js --port 5400    # port 5400, harness style
```

`--strictPort` is accepted and ignored: the port is always taken strictly, and
the launcher exits non-zero if it is already in use. `PORT` and `HOST` env vars
work as fallbacks for the two flags.

`harness.config.json` carries the contract: `smokeCommand: node demo/start.js`,
`portBase: 5400`, `portArg: --port`, `demoMode: true`. `npm start` is the
production server (`server/index.js`), not this launcher; see the README.

`hashRouting` is `false`, and that is deliberate. jitsi-meet routes rooms by
path (`/RoomName`) and the shell carries `<base href="/">`. The demo dev server
answers any non-asset path with the shell, so path routing survives a root
mounted proxy, which is the case when the harness assigns a dedicated port. It
would not survive being mounted under a sub-path.

Nothing external is needed to start or browse. Signalling is only proxied to
`WEBPACK_DEV_SERVER_PROXY_TARGET` at the moment a room is actually joined.
