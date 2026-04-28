#!/usr/bin/env bash
set -euo pipefail

rm -rf runtime/
mkdir runtime
# Install Node.js
curl -fSL --progress-bar https://nodejs.org/dist/v24.13.1/node-v24.13.1-darwin-arm64.tar.gz | tar xz -C runtime/ && mv runtime/node-v24.13.1-darwin-arm64 runtime/node

# Install OpenClaw
mkdir -p runtime/openclaw
cd runtime/openclaw
../node/bin/npm init -y > /dev/null
../node/bin/npm install openclaw@2026.4.14 --legacy-peer-deps
ln -sf node_modules/openclaw/openclaw.mjs openclaw.mjs
