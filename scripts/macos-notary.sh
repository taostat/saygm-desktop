#!/usr/bin/env bash
# Notarize and staple macOS release artifacts.
#
#   macos-notary.sh submit <file> <result.json>   notarize and require "Accepted"
#   macos-notary.sh staple <path>                 staple the ticket, with retries
#   macos-notary.sh validate <path>               validate the stapled ticket, with retries
#
# stapler fetches tickets from api.apple-cloudkit.com, and CI runners intermittently
# lose that connection (NSURLErrorDomain -1005, stapler exit 68), so stapler calls retry.
# Credentials come from the environment set by the "Prepare notarization credentials" step.
set -euo pipefail

readonly STAPLER_ATTEMPTS=5
readonly STAPLER_BACKOFF_SECONDS=30

submit() {
  local file="$1" result="$2"
  case "${SAYGM_NOTARIZATION_METHOD:-}" in
  app-store-connect)
    xcrun notarytool submit "$file" \
      --key "$APPLE_API_KEY_PATH" \
      --key-id "$APPLE_API_KEY_ID" \
      --issuer "$APPLE_API_ISSUER_ID" \
      --wait --output-format json >"$result"
    ;;
  apple-id)
    xcrun notarytool submit "$file" \
      --apple-id "$APPLE_ID" \
      --password "$APPLE_ID_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" \
      --wait --output-format json >"$result"
    ;;
  *)
    echo "::error::SAYGM_NOTARIZATION_METHOD must be app-store-connect or apple-id." >&2
    exit 1
    ;;
  esac
  node - "$file" "$result" <<'NODE'
const fs = require('node:fs');
const [file, resultPath] = process.argv.slice(2);
const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
if (result.status !== 'Accepted') {
  throw new Error(`Notarization of ${file} was not accepted (status: ${result.status ?? 'missing'}).`);
}
console.log(`Notarization of ${file} accepted; submission ${result.id ?? 'id unavailable'}.`);
NODE
}

stapler_with_retry() {
  local action="$1" path="$2" attempt
  for ((attempt = 1; attempt <= STAPLER_ATTEMPTS; attempt++)); do
    if xcrun stapler "$action" -v "$path"; then
      return 0
    fi
    if ((attempt < STAPLER_ATTEMPTS)); then
      echo "stapler $action failed for $path (attempt $attempt/$STAPLER_ATTEMPTS); retrying." >&2
      sleep $((STAPLER_BACKOFF_SECONDS * attempt))
    fi
  done
  echo "::error::stapler $action failed for $path after $STAPLER_ATTEMPTS attempts." >&2
  return 1
}

main() {
  if (($# < 2)); then
    echo "usage: $0 submit <file> <result.json> | staple <path> | validate <path>" >&2
    exit 2
  fi
  case "$1" in
  submit)
    (($# == 3)) || {
      echo "usage: $0 submit <file> <result.json>" >&2
      exit 2
    }
    submit "$2" "$3"
    ;;
  staple | validate)
    (($# == 2)) || {
      echo "usage: $0 $1 <path>" >&2
      exit 2
    }
    stapler_with_retry "$1" "$2"
    ;;
  *)
    echo "usage: $0 submit <file> <result.json> | staple <path> | validate <path>" >&2
    exit 2
    ;;
  esac
}

main "$@"
