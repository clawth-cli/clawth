#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

CURRENT=$(node -p "require('./package.json').version")

echo ""
echo -e "${BOLD}Clawth — Publish to npm${NC}"
echo -e "${DIM}Current version: ${CURRENT}${NC}"
echo ""

# ── Version bump ─────────────────────────────────────────────────────────────

if [[ "${1:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
  # Explicit version passed as argument
  VERSION="$1"
elif [[ "${1:-}" =~ ^(patch|minor|major)$ ]]; then
  # Bump type passed as argument
  VERSION=$(npm version "$1" --no-git-tag-version --json 2>/dev/null | node -p "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'))" 2>/dev/null || npm version "$1" --no-git-tag-version)
  VERSION="${VERSION//\"/}"
  VERSION="${VERSION//v/}"
else
  # Interactive
  echo "  How do you want to bump the version?"
  echo ""
  echo -e "    ${BOLD}1)${NC} patch  ${DIM}${CURRENT} → $(node -p "const [a,b,c]='${CURRENT}'.split('.'); [a,b,+c+1].join('.')")${NC}"
  echo -e "    ${BOLD}2)${NC} minor  ${DIM}${CURRENT} → $(node -p "const [a,b]='${CURRENT}'.split('.'); [a,+b+1,0].join('.')")${NC}"
  echo -e "    ${BOLD}3)${NC} major  ${DIM}${CURRENT} → $(node -p "const [a]='${CURRENT}'.split('.'); [+a+1,0,0].join('.')")${NC}"
  echo -e "    ${BOLD}4)${NC} custom"
  echo ""
  read -rp "  Choice (1): " choice
  choice="${choice:-1}"

  case "$choice" in
    1) BUMP="patch" ;;
    2) BUMP="minor" ;;
    3) BUMP="major" ;;
    4)
      read -rp "  Version: " VERSION
      if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
        echo -e "${RED}Invalid version: ${VERSION}${NC}"
        exit 1
      fi
      ;;
    *)
      echo -e "${RED}Invalid choice${NC}"
      exit 1
      ;;
  esac

  if [[ -z "${VERSION:-}" ]]; then
    npm version "$BUMP" --no-git-tag-version > /dev/null
    VERSION=$(node -p "require('./package.json').version")
  else
    npm version "$VERSION" --no-git-tag-version > /dev/null
  fi
fi

# If version was passed as arg (explicit semver), apply it
if [[ -n "${VERSION:-}" ]] && [[ "$VERSION" != "$(node -p "require('./package.json').version")" ]]; then
  npm version "$VERSION" --no-git-tag-version > /dev/null
fi

VERSION=$(node -p "require('./package.json').version")
echo ""
echo -e "  Version: ${BOLD}${VERSION}${NC}"

# ── Tests ────────────────────────────────────────────────────────────────────

echo ""
echo -e "${BLUE}Running tests...${NC}"
bun test
echo ""

# ── Publish ──────────────────────────────────────────────────────────────────

read -rp "  Publish v${VERSION} to npm? (Y/n): " confirm
if [[ "${confirm:-y}" =~ ^[Nn]$ ]]; then
  echo "Aborted. Version bumped but not published."
  echo "To revert: git checkout package.json"
  exit 0
fi

echo ""
npm publish --access public
echo ""

# ── Git tag + push ───────────────────────────────────────────────────────────

git add package.json
git commit -m "v${VERSION}"
git tag "v${VERSION}"
git push && git push --tags

echo ""
echo -e "${GREEN}${BOLD}Published clawth@${VERSION}${NC}"
echo -e "${DIM}https://www.npmjs.com/package/clawth${NC}"
echo ""
