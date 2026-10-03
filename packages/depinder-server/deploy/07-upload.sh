#!/usr/bin/env bash
# Copies to APP_DIR on the server: the source the image is built from (your working tree, so
# uncommitted changes go too, laid out as in the monorepo, whose root is the build context),
# compose.yml, and server.env (this env file, readable by root only). Also installs `depinder`, a
# shortcut for compose with those files. To ship new code later: run this again, then 08-start.sh.
source "$(dirname "$0")/lib.sh"

# What the Dockerfile copies (it lists every workspace's package.json), plus the Caddyfile.
SERVER=packages/depinder-server
SOURCES=(package.json package-lock.json tsconfig.base.json .dockerignore
  packages/depinder-cli/package.json bench/package.json
  "$SERVER/package.json" "$SERVER/Dockerfile" "$SERVER/tsconfig.json" "$SERVER/tsconfig.build.json"
  "$SERVER/src" "$SERVER/migrations" "$SERVER/Caddyfile")

cd "$MONOREPO_DIR"
version="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
git diff --quiet HEAD -- "${SOURCES[@]}" 2>/dev/null || version="$version+dirty"

step "source $version -> $SERVER_IP:$APP_DIR/src"
remote "rm -rf '$APP_DIR/src' && mkdir -p '$APP_DIR/src'"
# No macOS metadata (xattrs, ._ files): GNU tar on the server would warn about every file.
COPYFILE_DISABLE=1 tar --no-xattrs -czf - "${SOURCES[@]}" \
  | remote "tar --warning=no-unknown-keyword -xzf - -C '$APP_DIR/src' && echo '$version' > '$APP_DIR/src/VERSION'"

step "compose.yml, server.env, compose.vars"
upload "$DEPLOY_DIR/compose.server.yml" "$APP_DIR/compose.yml"
upload "$ENV_FILE" "$APP_DIR/server.env"
remote "chmod 600 '$APP_DIR/server.env'"
# Only what compose.yml substitutes as ${...}: compose would expand any `$` in a file it reads for
# substitution, so the secrets stay out of this one.
printf 'SITE_ADDRESS=%s\nVULN_CPUS=%s\nVULN_MEM_LIMIT=%s\n' \
  "$SITE_ADDRESS" "${VULN_CPUS:-1.5}" "${VULN_MEM_LIMIT:-2500m}" \
  | remote "cat > '$APP_DIR/compose.vars'"

step "the depinder shortcut"
remote "cat > /usr/local/bin/depinder && chmod 755 /usr/local/bin/depinder" <<SHORTCUT
#!/bin/sh
# depinder <compose command>, e.g. depinder ps / depinder logs -f resolver / depinder restart
cd '$APP_DIR' && exec docker compose --env-file compose.vars -f compose.yml "\$@"
SHORTCUT
remote "ls -la '$APP_DIR'; echo \"version: \$(cat '$APP_DIR/src/VERSION')\""
