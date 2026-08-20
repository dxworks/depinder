<!-- ai-index v1 · depth: files=signatures, subdirs=names -->
# src/assets

**Role:** Local-development infrastructure assets for running depinder's MongoDB backend via Docker.

## Files
- `depinder.docker-compose.yml` — Docker Compose stack (mongo + mongo-express behind Traefik); consumed by `docker compose -f` when starting a local depinder dev environment; a redis-stack service is present but commented out.
- `init-mongo.js` — Mongo init script mounted into the `mongo` container's `docker-entrypoint-initdb.d`; creates the `depinder` db user/role and seeds an `intialisationCollection` marker document.
- `.gitkeep` — empty placeholder keeping the directory tracked by git.

## Notes
- `init-mongo.js` is wired in by bind mount in `depinder.docker-compose.yml`, not referenced from application code — edit both together if changing DB credentials.
