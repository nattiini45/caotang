#!/usr/bin/env bash
# Installs a pinned veraPDF on a CI runner (CI only; nothing here ships).
#
#   bash tools/ci/verapdf-install.sh <version> <sha256> <directory>
#
# veraPDF has no Ubuntu package, so this takes the release's IzPack installer from veraPDF's own downloads host, checks it against
# the SHA-256 the job pins, and unpacks it with the installer's console mode and a properties file that answers its one question,
# the install path. The installer needs a Java runtime and uses the runner's own; the version is read back from the installed
# command afterwards, so a tree that unpacked as another version fails here rather than in the gate.
set -euo pipefail

version="${1:?the pinned version, e.g. 1.30.4}"
expected="${2:?the pinned SHA-256 of the installer}"
dir="${3:?the directory to install into}"

command -v java > /dev/null || {
  echo "::error::veraPDF is a Java program and no Java runtime is on this runner's PATH."
  exit 1
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Releases live under the major and minor version: 1.30.4's installer is in /rel/1.30/.
url="https://downloads.verapdf.org/rel/${version%.*}/verapdf-greenfield-$version-installer.zip"
echo "Downloading $url"
curl -fsSL --retry 3 --retry-delay 5 --connect-timeout 30 -o "$work/installer.zip" "$url"

actual="$(sha256sum "$work/installer.zip" | cut -d' ' -f1)"
if [ "$actual" != "$expected" ]; then
  echo "::error::The veraPDF $version installer has SHA-256 $actual, and the job pins $expected."
  exit 1
fi

unzip -q "$work/installer.zip" -d "$work"
mkdir -p "$dir"
printf 'INSTALL_PATH=%s\n' "$dir" > "$work/options.properties"
# Console mode with an options file and no standard input: it installs every pack the installer ships (the CLI, the GUI and the
# documentation) into $dir and asks nothing.
java -jar "$work/verapdf-greenfield-$version/verapdf-izpack-installer-$version.jar" -options "$work/options.properties" < /dev/null

installed="$("$dir/verapdf" --version | head -1)"
test "$installed" = "veraPDF $version" || {
  echo "::error::The installed command reports \"$installed\", and the job pins veraPDF $version."
  exit 1
}
echo "Installed $installed in $dir"
