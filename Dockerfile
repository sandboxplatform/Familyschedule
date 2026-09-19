# Hearth has no dependencies, so the image is just Node plus the source.
FROM node:22-alpine

# su-exec drops privileges in the entrypoint, after it has handed whatever
# volume is mounted to the user the app runs as.
RUN apk add --no-cache su-exec

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/

RUN mkdir -p /app/data \
 && chown -R node:node /app \
 && chmod +x /usr/local/bin/docker-entrypoint.sh

# Deliberately no USER: the entrypoint starts as root so it can take ownership
# of a root-owned mount, then becomes node before running anything of ours.
# Dropping here instead would leave a mounted volume unwritable, which fails by
# silently storing the calendar somewhere that does not survive a deploy.

ENV PORT=4321
# Declares this as a deployment, not a checkout: a volume mounted anywhere we
# look for one is used, and the demo household is left out. Pinning HEARTH_DATA
# here instead would quietly ignore a volume mounted at /data, which is where
# a host's dashboard puts one by default.
ENV HEARTH_HOSTED=1
EXPOSE 4321

# No VOLUME instruction on purpose. Railway rejects the build outright with
# "docker VOLUME is not supported, use Railway Volumes", and it buys nothing
# anywhere else: compose mounts hearth-data at /app/data explicitly, and hosts
# mount their own. A bare `docker run` with no -v keeps the calendar inside the
# container either way, which is what the start-up warning is there to say.

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1:4321/api/health || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
