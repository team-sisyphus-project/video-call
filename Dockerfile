# syntax=docker/dockerfile:1
# Publish image for the MeetSpace demo. The webpack build (make compile deploy) is committed under
# libs/ + css/all.css — building jitsi-meet needs an 8GB heap and ~10 minutes, well outside the
# publish budget. demo/serve-static.js serves the shell and proxies signalling to MEETSPACE_BACKEND.
FROM node:20.19.4-slim
WORKDIR /app
COPY index.html base.html body.html fonts.html head.html plugin.head.html title.html manifest.json pwa-worker.js ./
COPY libs ./libs
COPY css ./css
COPY images ./images
COPY lang ./lang
COPY sounds ./sounds
COPY static ./static
COPY demo ./demo
RUN node demo/build-static.js
USER node
EXPOSE 8080
CMD ["node", "demo/serve-static.js"]
