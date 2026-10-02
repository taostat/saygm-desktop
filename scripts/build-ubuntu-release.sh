#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo "This release build must run on native Ubuntu x86_64." >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact_dir="${1:?Usage: scripts/build-ubuntu-release.sh <artifact-directory>}"
artifact_dir="$(mkdir -p "$artifact_dir" && cd "$artifact_dir" && pwd)"
build_parent="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
build_out=""
staged_goose="$repo_root/ui/desktop/src/bin/goose"
source_goose="$repo_root/target/release/goose"
temporary_stage="${staged_goose}.rc5-tmp"
release_version="$(node -p "require('$repo_root/ui/desktop/package.json').version")"

if [[ "$release_version" != 0.1.0-rc.5 ]]; then
  echo "Expected desktop version 0.1.0-rc.5, found $release_version." >&2
  exit 2
fi
if [[ -e "$staged_goose" || -L "$staged_goose" || -e "$temporary_stage" ]]; then
  echo "Refusing to replace an existing desktop backend binary." >&2
  exit 2
fi

mkdir -p "$artifact_dir" "$build_parent"
build_out="$(mktemp -d "$build_parent/saygm-ubuntu-rc5-forge.XXXXXX")"
staged=false
source_hash=""
work_dir=""
cleanup() {
  if [[ -n "$work_dir" ]]; then rm -rf "$work_dir"; fi
  if [[ -n "$build_out" ]]; then rm -rf "$build_out"; fi
  if [[ "$staged" == true && -f "$staged_goose" ]]; then
    local current_hash
    current_hash="$(sha256sum "$staged_goose" | cut -d ' ' -f 1)"
    if [[ "$current_hash" == "$source_hash" ]]; then
      rm -f "$staged_goose"
    else
      echo "Staged Goose changed during packaging; preserving it for inspection." >&2
      exit 1
    fi
  fi
  rm -f "$temporary_stage"
}
trap cleanup EXIT

cd "$repo_root"
cargo build --locked --release -p goose-cli --bin goose
test -x "$source_goose"
readelf -h "$source_goose" | grep -F 'Machine:                           Advanced Micro Devices X86-64'
source_hash="$(sha256sum "$source_goose" | cut -d ' ' -f 1)"
install -m 0755 "$source_goose" "$temporary_stage"
mv "$temporary_stage" "$staged_goose"
staged=true

pnpm --dir ui/desktop run build-goose-acp-client
pnpm --dir ui/desktop run i18n:compile
SAYGM_RELEASE_OUT_DIR="$build_out" ELECTRON_ARCH=x64 pnpm --dir ui/desktop exec electron-forge make \
  --platform=linux \
  --arch=x64 \
  --targets=@electron-forge/maker-deb,@electron-forge/maker-zip

deb_source="$(find "$build_out" -type f -name '*.deb' -print -quit)"
zip_source="$(find "$build_out" -type f -name '*.zip' -print -quit)"
if [[ -z "$deb_source" || -z "$zip_source" ]]; then
  echo "Forge did not produce both the Debian and portable ZIP packages." >&2
  find "$build_out" -maxdepth 6 -type f -print >&2
  exit 1
fi

final_deb="$artifact_dir/SayGM-${release_version}-linux-x64.deb"
final_zip="$artifact_dir/SayGM-${release_version}-linux-x64.zip"
if [[ -e "$final_deb" || -e "$final_zip" ]]; then
  echo "Refusing to overwrite existing Ubuntu RC5 artifacts in $artifact_dir." >&2
  exit 2
fi
cp "$deb_source" "$final_deb"
cp "$zip_source" "$final_zip"

work_dir="$(mktemp -d)"
package_root="$work_dir/package"
mkdir -p "$package_root"
dpkg-deb --raw-extract "$final_deb" "$package_root"
desktop_file="$(find "$package_root/usr/share/applications" -maxdepth 1 -type f -name '*.desktop' -print -quit)"
if [[ -z "$desktop_file" ]]; then
  echo "Debian package does not contain its desktop entry." >&2
  exit 1
fi
sed -i -e 's|^Exec=.*|Exec=/usr/bin/saygm %U|' -e 's|^Icon=.*|Icon=saygm|' "$desktop_file"
grep -Fx 'Exec=/usr/bin/saygm %U' "$desktop_file"
grep -Fx 'Icon=saygm' "$desktop_file"

package_goose="$package_root/usr/lib/saygm/resources/bin/goose"
if [[ ! -x "$package_goose" ]]; then
  echo "Debian package layout changed: missing /usr/lib/saygm/resources/bin/goose." >&2
  find "$package_root/usr" -maxdepth 6 -type f -print >&2
  exit 1
fi
if [[ "$(sha256sum "$package_goose" | cut -d ' ' -f 1)" != "$source_hash" ]]; then
  echo "Debian backend differs from the Cargo release binary." >&2
  exit 1
fi

runtime_packages=(libsecret-1-0)
while IFS= read -r library; do
  [[ -n "$library" ]] || continue
  owner=""
  resolved_library="$(readlink -f -- "$library" 2>/dev/null || true)"
  for candidate in "$library" "$resolved_library"; do
    [[ -n "$candidate" ]] || continue
    owner="$(dpkg-query -S "$candidate" 2>/dev/null | head -n 1 | sed 's/: .*//' || true)"
    owner="${owner%%:*}"
    [[ -n "$owner" ]] && break
  done
  if [[ -z "$owner" ]]; then
    echo "Cannot map bundled Goose runtime library to an Ubuntu package: $library" >&2
    exit 1
  fi
  printf 'Goose runtime library %s is provided by %s\n' "$library" "$owner"
  runtime_packages+=("$owner")
done < <(ldd "$package_goose" | awk '/=> \// {sub(/^.*=> /, ""); sub(/ .*/, ""); print} /^[[:space:]]*\// {print $1}')

python3 - "$package_root/DEBIAN/control" "${runtime_packages[@]}" <<'PY'
import pathlib
import re
import sys

control = pathlib.Path(sys.argv[1])
required = list(dict.fromkeys(sys.argv[2:]))
text = control.read_text()
match = re.search(r"(?ms)^Depends:(.*?)(?=^[A-Za-z0-9][A-Za-z0-9-]*:|\Z)", text)
existing = []
if match:
    raw = " ".join(part.strip() for part in match.group(1).splitlines()).strip()
    existing = [part.strip() for part in raw.split(",") if part.strip()]
names = {re.match(r"([a-z0-9][a-z0-9+.-]*)", dep).group(1) for dep in existing}
for package in required:
    if package not in names:
        existing.append(package)
        names.add(package)
if not existing:
    raise SystemExit("Debian package has no runtime Depends entries")
lines = []
field = "Depends: "
for dependency in existing:
    addition = (", " if field != "Depends: " else "") + dependency
    if len(field) + len(addition) > 78 and field != "Depends: ":
        lines.append(field.rstrip() + ",")
        field = " " + dependency
    else:
        field += addition
lines.append(field)
replacement = chr(10).join(lines) + chr(10)
if match:
    text = text[:match.start()] + replacement + text[match.end():]
else:
    text = text.rstrip() + chr(10) + replacement
control.write_text(text)
PY

rebuilt_deb="$work_dir/rebuilt.deb"
dpkg-deb --build --root-owner-group "$package_root" "$rebuilt_deb" >/dev/null
mv "$rebuilt_deb" "$final_deb"

node "$repo_root/scripts/verify-ubuntu-release.mjs" \
  --deb "$final_deb" \
  --zip "$final_zip" \
  --source-backend "$source_goose" \
  --report "$artifact_dir/package-verification.json"

cat > "$artifact_dir/INSTALL-UBUNTU.txt" <<EOF
SayGM Desktop ${release_version} for Ubuntu x86_64

Install the Debian package with: sudo apt install ./SayGM-${release_version}-linux-x64.deb
The portable ZIP contains the app and can be extracted and launched without installing the package.

Linux credentials require an unlocked Secret Service provider such as GNOME Keyring.
SayGM refuses OAuth setup when secure storage is unavailable; basic_text storage is not accepted.

This is a private RC5 build using production SayGM API and gateway endpoints.
No account login or inference was performed by the package build.
EOF

cat > "$artifact_dir/BUILD-INFO.txt" <<EOF
Version: ${release_version}
Platform: Ubuntu 22.04 x86_64
Backend source: target/release/goose built by cargo build --locked --release -p goose-cli --bin goose
Backend SHA-256: ${source_hash}
Build commit: $(git -C "$repo_root" rev-parse HEAD)
EOF

echo "Ubuntu RC5 artifacts created in $artifact_dir"
