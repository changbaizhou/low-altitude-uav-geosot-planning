#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR/frontend"

if [[ ! -d node_modules ]]; then
  npm install
fi

npm run dev -- --host 127.0.0.1 --port 5173

