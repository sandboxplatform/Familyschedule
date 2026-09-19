# Hearth has no dependencies, so the image is just Node plus the source.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public

# Run unprivileged, and make sure the calendar's home is writable whether it
# stays inside the image or gets a mounted volume.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV PORT=4321
# Declares this as a deployment, not a checkout: a volume mounted anywhere we
# look for one is used, and the demo household is left out. Pinning HEARTH_DATA
# here instead would quietly ignore a volume mounted at /data, which is where
# a host's dashboard puts one by default.
ENV HEARTH_HOSTED=1
VOLUME ["/app/data"]
EXPOSE 4321

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1:4321/api/health || exit 1

CMD ["node", "server/index.js"]
