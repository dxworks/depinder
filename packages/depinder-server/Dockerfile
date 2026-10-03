# The scanners ROLE=vuln runs, taken from their publishers' own images. Pinned by the multi-arch
# index digest, so amd64 and arm64 hosts get the same release and a moved tag changes nothing.
# Both are static Go binaries: alpine's musl is no obstacle.
FROM aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969 AS trivy
FROM anchore/grype:v0.118.0@sha256:8a93fc48da96bd6ec5981279d099b69de11541dc68fdf222fb9161f8ff284af7 AS grype

# Build stage: dev dependencies and the TypeScript compiler, none of which ship.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Runtime stage: production dependencies, the compiled output, the migrations and the two scanners.
# The resolver roles never call the scanners; one image for every role is simpler than two.
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=trivy /usr/local/bin/trivy /usr/local/bin/trivy
COPY --from=grype /grype /usr/local/bin/grype

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY migrations ./migrations

# ROLE=vuln keeps its databases in VULN_DATA_DIR, a volume mounted here. The folder exists in the
# image, owned by `node`, so that an empty named volume takes that owner the first time it mounts.
RUN mkdir -p /var/lib/vuln && chown node:node /var/lib/vuln

# The node image ships an unprivileged `node` user. Only ROLE=vuln writes: its volume and /tmp.
USER node

EXPOSE 8080

# ROLE=worker containers serve no HTTP: disable this check for them
# (`healthcheck: {disable: true}` in compose). ROLE=vuln needs a longer start period: its first boot
# on an empty volume downloads both databases (docker-compose.yml).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
