#!/usr/bin/env bash
# Retry setup only. Never retry the posting application here.
set -euo pipefail
case "${1:-}" in
  deps) args=(install-deps chromium) ;;
  browser) args=(install chromium --only-shell) ;;
  *) echo 'Usage: install-browser.sh deps|browser' >&2; exit 2 ;;
esac
for attempt in 1 2 3; do
  echo "Playwright ${1}: attempt ${attempt}/3"
  if npx --no-install playwright "${args[@]}"; then
    exit 0
  else
    status=$?
  fi
  # Preserve cancellation rather than treating it as a transient failure.
  if (( status == 130 || status == 143 )); then exit "$status"; fi
  if (( attempt == 3 )); then
    echo "Playwright ${1}: setup failed after 3 attempts" >&2
    exit "$status"
  fi
  delay=$((attempt * 20))
  echo "Playwright ${1}: retrying in ${delay}s"
  sleep "$delay"
done
