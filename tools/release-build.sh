#!/usr/bin/env bash
# Build and test step of the release gate (dxworks/pipelines release-gate.yml).
set -euo pipefail
npm ci
npm run check
