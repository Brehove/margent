#!/usr/bin/env bash
set -euo pipefail

patterns=(
  'BEGIN RSA PRIVATE KEY'
  'BEGIN OPENSSH PRIVATE KEY'
  'ANTHROPIC_API_KEY='
  'OPENAI_API_KEY='
  'GITHUB_TOKEN='
)

status=0
grep_paths=(-- . ':(exclude)package-lock.json' ':(exclude)scripts/check-public-hygiene.sh')

user_path_hits="$(git grep -n -I '/Users/' "${grep_paths[@]}" || true)"
user_path_hits="$(printf '%s\n' "$user_path_hits" | grep -v '/Users/example' || true)"
if [[ -n "$user_path_hits" ]]; then
  printf '%s\n' "$user_path_hits"
  echo "public hygiene check failed: found a non-synthetic /Users/ path" >&2
  status=1
fi

for pattern in "${patterns[@]}"; do
  if git grep -n -I -F "$pattern" "${grep_paths[@]}"; then
    echo "public hygiene check failed: found '$pattern'" >&2
    status=1
  fi
done

exit "$status"
