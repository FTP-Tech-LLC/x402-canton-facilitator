# Runs beside the Canton participant, holding the node-local admin access the
# facilitator deliberately does not have. One read-only method, nothing else.
FROM node:22-alpine

WORKDIR /app
# Deps first so a code change does not re-resolve the tree.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# The vendored Canton protos are runtime data, not build input: proto-loader
# reads them from disk at startup. See proto/SOURCE for where they came from.
COPY proto ./proto
COPY dist ./dist

# Loopback by default; the compose file publishes it on the VPN interface only.
ENV TOPOLOGY_READER_HOST=0.0.0.0
ENV TOPOLOGY_READER_PORT=8099
EXPOSE 8099

# No shell form: a signal must reach node, not a shell wrapper.
CMD ["node", "dist/cli.js"]
