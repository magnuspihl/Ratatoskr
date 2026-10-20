#!/usr/bin/env bash
# Prints the version a release should get (MAJOR.MINOR.PATCH, no "v"). Used by the Release workflow.
#
#   release-version.sh bump patch|minor|major   next version after the newest v* tag (base 0.0.0)
#   release-version.sh tag v1.2.3               the pushed tag's version, checked
#
# Run inside the repository with tags fetched. Tags that aren't vMAJOR.MINOR.PATCH (v2.0.0-rc1) are
# ignored when bumping. Fails when the version isn't MAJOR.MINOR.PATCH.
set -euo pipefail

fail() {
  echo "$*" >&2
  exit 1
}

case "${1:-}" in
  bump)
    latest_tag="$(git tag --list 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n1 || true)"
    latest="${latest_tag#v}"
    IFS='.' read -r major minor patch <<< "${latest:-0.0.0}"
    case "${2:-}" in
      major) major=$((major + 1)); minor=0; patch=0 ;;
      minor) minor=$((minor + 1)); patch=0 ;;
      patch) patch=$((patch + 1)) ;;
      *) fail "bump must be patch, minor or major, got '${2:-}'" ;;
    esac
    version="${major}.${minor}.${patch}"
    ;;
  tag)
    version="${2:-}"
    version="${version#v}"
    ;;
  *)
    fail "usage: $0 bump patch|minor|major | $0 tag vX.Y.Z"
    ;;
esac

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "'$version' is not a MAJOR.MINOR.PATCH version"
echo "$version"
