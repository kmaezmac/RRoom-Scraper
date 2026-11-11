#!/usr/bin/env bash
set -euo pipefail

# Check inside the container, without reading or exposing session contents.
# Session directories/files intentionally retain their 0700/0600 permissions.
for file in "${1:-.state}"/*.enc; do
  if [[ -f "$file" && ! -L "$file" ]]; then
    echo 'exists=true'
    exit 0
  fi
done
echo 'exists=false'
