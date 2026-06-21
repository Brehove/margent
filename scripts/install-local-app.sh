#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

app_name="Margent.app"
built_app="$repo_root/target/release/bundle/macos/$app_name"
target_mode="${MARGENT_INSTALL_TARGET:-system}"
run_build=1
open_after=1
dry_run=0

usage() {
  cat <<'EOF'
Usage: scripts/install-local-app.sh [options]

Build and install the local Margent.app bundle, then verify the installed and
running binary. The default target is /Applications/Margent.app.

Options:
  --target system       Install to /Applications/Margent.app (default).
  --target user         Install to ~/Applications/Margent.app.
  --target both         Install to both standard app locations.
  --target PATH         Install to a custom Margent.app path.
  --system              Shortcut for --target system.
  --user                Shortcut for --target user.
  --both                Shortcut for --target both.
  --no-build            Reuse the existing target/release bundle.
  --no-open             Do not relaunch Margent after installing.
  --dry-run             Print the planned actions without changing anything.
  -h, --help            Show this help.

Environment:
  MARGENT_INSTALL_TARGET may be system, user, both, or a custom app path.
EOF
}

while (($#)); do
  case "$1" in
    --target)
      if [[ $# -lt 2 ]]; then
        echo "install-local-app: --target requires system, user, both, or a path" >&2
        exit 2
      fi
      target_mode="$2"
      shift 2
      ;;
    --system)
      target_mode="system"
      shift
      ;;
    --user)
      target_mode="user"
      shift
      ;;
    --both)
      target_mode="both"
      shift
      ;;
    --no-build)
      run_build=0
      shift
      ;;
    --no-open)
      open_after=0
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "install-local-app: unknown option '$1'" >&2
      usage >&2
      exit 2
      ;;
  esac
done

expand_path() {
  case "$1" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s/%s\n' "$HOME" "${1#~/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

install_targets=()
case "$target_mode" in
  system)
    install_targets=("/Applications/$app_name")
    ;;
  user)
    install_targets=("$HOME/Applications/$app_name")
    ;;
  both)
    install_targets=("/Applications/$app_name" "$HOME/Applications/$app_name")
    ;;
  *)
    install_targets=("$(expand_path "$target_mode")")
    ;;
esac

for target in "${install_targets[@]}"; do
  if [[ "$(basename "$target")" != "$app_name" ]]; then
    echo "install-local-app: target must end with $app_name: $target" >&2
    exit 2
  fi
done

standard_targets=("/Applications/$app_name" "$HOME/Applications/$app_name")

binary_hash() {
  shasum -a 256 "$1/Contents/MacOS/margent" | awk '{print $1}'
}

report_standard_installs() {
  local existing=()
  local target
  for target in "${standard_targets[@]}"; do
    if [[ -d "$target" ]]; then
      existing+=("$target")
    fi
  done

  if ((${#existing[@]} <= 1)); then
    return
  fi

  echo "Detected multiple Margent.app bundles:" >&2
  local first_hash=""
  local mismatch=0
  for target in "${existing[@]}"; do
    local hash="missing-binary"
    if [[ -f "$target/Contents/MacOS/margent" ]]; then
      hash="$(binary_hash "$target")"
      if [[ -z "$first_hash" ]]; then
        first_hash="$hash"
      elif [[ "$hash" != "$first_hash" ]]; then
        mismatch=1
      fi
    fi
    echo "  $target  $hash" >&2
  done

  if ((mismatch)); then
    echo "Warning: installed Margent bundles differ. Use --target both to synchronize them." >&2
  else
    echo "Note: duplicate Margent bundles exist, but their binaries currently match." >&2
  fi
}

print_plan() {
  echo "Margent local app install"
  echo "  repo: $repo_root"
  echo "  build: $([[ "$run_build" == 1 ]] && echo yes || echo no)"
  echo "  built app: $built_app"
  echo "  target mode: $target_mode"
  printf '  targets:\n'
  printf '    %s\n' "${install_targets[@]}"
  echo "  open after install: $([[ "$open_after" == 1 ]] && echo yes || echo no)"
}

print_plan
report_standard_installs

if ((dry_run)); then
  echo "Dry run only; no changes made."
  exit 0
fi

if ((run_build)); then
  npm run tauri build
fi

if [[ ! -d "$built_app" ]]; then
  echo "install-local-app: built app not found at $built_app" >&2
  echo "Run npm run tauri build, or omit --no-build." >&2
  exit 1
fi

osascript -e 'quit app "Margent"' >/dev/null 2>&1 || true
sleep 1
if pgrep -x margent >/dev/null 2>&1; then
  echo "Stopping existing Margent process before reinstalling." >&2
  pkill -x margent || true
  sleep 1
fi

for target in "${install_targets[@]}"; do
  mkdir -p "$(dirname "$target")"
  ditto "$built_app" "$target"
done

built_hash="$(binary_hash "$built_app")"
for target in "${install_targets[@]}"; do
  installed_hash="$(binary_hash "$target")"
  if [[ "$installed_hash" != "$built_hash" ]]; then
    echo "install-local-app: binary hash mismatch for $target" >&2
    echo "  built:     $built_hash" >&2
    echo "  installed: $installed_hash" >&2
    exit 1
  fi
done

report_standard_installs

if ((open_after)); then
  primary_target="${install_targets[0]}"
  expected_binary="$primary_target/Contents/MacOS/margent"
  open "$primary_target"
  sleep 3

  running_expected=0
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    executable="$(lsof -p "$pid" 2>/dev/null | awk '$4 == "txt" {print $9; exit}')"
    if [[ "$executable" == "$expected_binary" ]]; then
      running_expected=1
      echo "Running Margent: pid $pid -> $executable"
    elif [[ -n "$executable" ]]; then
      echo "Warning: Margent pid $pid is running from $executable" >&2
    fi
  done < <(pgrep -x margent || true)

  if ((running_expected == 0)); then
    echo "install-local-app: Margent did not appear to launch from $expected_binary" >&2
    exit 1
  fi
fi

echo "Installed Margent.app successfully."
