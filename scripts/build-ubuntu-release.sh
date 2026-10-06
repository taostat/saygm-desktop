#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact_dir="${1:?Usage: scripts/build-ubuntu-release.sh <artifact-directory> <x64|arm64>}"
build_arch="${2:?Usage: scripts/build-ubuntu-release.sh <artifact-directory> <x64|arm64>}"
artifact_dir="$(mkdir -p "$artifact_dir" && cd "$artifact_dir" && pwd)"
build_parent="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
build_out=""
staged_goose="$repo_root/ui/desktop/src/bin/goose"
source_goose="$repo_root/target/release/goose"
temporary_stage="${staged_goose}.release-tmp"
release_version="${SAYGM_BETA_VERSION:-$(node -p "require('$repo_root/ui/desktop/package.json').version")}"

case "$build_arch" in
  x64)
    expected_host_arch=x86_64
    expected_machine='Advanced Micro Devices X86-64'
    debian_arch=amd64
    ;;
  arm64)
    expected_host_arch=aarch64
    expected_machine=AArch64
    debian_arch=arm64
    ;;
  *)
    echo "Unsupported Ubuntu architecture: $build_arch" >&2
    exit 2
    ;;
esac

if [[ "$(uname -s)" != Linux || "$(uname -m)" != "$expected_host_arch" ]]; then
  echo "This release build must run on native Ubuntu $expected_host_arch." >&2
  exit 2
fi
if [[ ! "$release_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Desktop version must be a semantic version with an optional prerelease label, found $release_version." >&2
  exit 2
fi
if [[ -e "$staged_goose" || -L "$staged_goose" || -e "$temporary_stage" ]]; then
  echo "Refusing to replace an existing desktop backend binary." >&2
  exit 2
fi

mkdir -p "$artifact_dir" "$build_parent"
build_out="$(mktemp -d "$build_parent/saygm-ubuntu-${release_version}-forge.XXXXXX")"
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
readelf -h "$source_goose" | grep -F "$expected_machine"
source_hash="$(sha256sum "$source_goose" | cut -d ' ' -f 1)"
install -m 0755 "$source_goose" "$temporary_stage"
mv "$temporary_stage" "$staged_goose"
staged=true

pnpm --dir ui/desktop run build-goose-acp-client
pnpm --dir ui/desktop run i18n:compile
SAYGM_BETA_VERSION="$release_version" SAYGM_RELEASE_OUT_DIR="$build_out" ELECTRON_ARCH="$build_arch" pnpm --dir ui/desktop exec electron-forge make \
  --platform=linux \
  --arch="$build_arch" \
  --targets=@electron-forge/maker-deb,@electron-forge/maker-zip

deb_source="$(find "$build_out" -type f -name '*.deb' -print -quit)"
zip_source="$(find "$build_out" -type f -name '*.zip' -print -quit)"
if [[ -z "$deb_source" || -z "$zip_source" ]]; then
  echo "Forge did not produce both the Debian and portable ZIP packages." >&2
  find "$build_out" -maxdepth 6 -type f -print >&2
  exit 1
fi

final_deb="$artifact_dir/SayGM-${release_version}-linux-${build_arch}.deb"
final_zip="$artifact_dir/SayGM-${release_version}-linux-${build_arch}.zip"
if [[ -e "$final_deb" || -e "$final_zip" ]]; then
  echo "Refusing to overwrite existing Ubuntu artifacts in $artifact_dir." >&2
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

# Electron loads libasound at runtime; build runners have its -dev package
# already installed, so declare the runtime package explicitly in the DEB.
runtime_packages=(libsecret-1-0 libasound2)
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

# Free the expanded .deb tree and Forge's source archives before package QA.
rm -rf "$work_dir" "$build_out"
work_dir=""
build_out=""

node "$repo_root/scripts/verify-ubuntu-release.mjs" \
  --deb "$final_deb" \
  --zip "$final_zip" \
  --source-backend "$source_goose" \
  --arch "$build_arch" \
  --expected-version "$release_version" \
  --report "$artifact_dir/package-verification.json"
node "$repo_root/scripts/verify-beta-source-base.mjs" "${SAYGM_PRODUCT_SOURCE_SHA:?SAYGM_PRODUCT_SOURCE_SHA is required for beta artifacts}" \
  > "$artifact_dir/source-verification.json"

cat > "$artifact_dir/INSTALL-UBUNTU.txt" <<EOF
SayGM Desktop ${release_version} for Ubuntu ${build_arch}

Install the Debian package with: sudo apt install ./SayGM-${release_version}-linux-${build_arch}.deb
The portable ZIP contains the app and can be extracted and launched without installing the package.

Linux credentials require an unlocked Secret Service provider such as GNOME Keyring.
SayGM refuses OAuth setup when secure storage is unavailable; basic_text storage is not accepted.

This is a private ${release_version} build using production SayGM API and gateway endpoints.
No account login or inference was performed by the package build.
EOF

cat > "$artifact_dir/BUILD-INFO.txt" <<EOF
Version: ${release_version}
Platform: Ubuntu 22.04 ${build_arch}
Product source revision: ${SAYGM_PRODUCT_SOURCE_SHA:-unknown}
Build automation revision: $(git -C "$repo_root" rev-parse HEAD)
Backend source: target/release/goose built by cargo build --locked --release -p goose-cli --bin goose
Backend SHA-256: ${source_hash}
EOF

echo "Ubuntu ${release_version} artifacts created in $artifact_dir"
