#!/usr/bin/env bash
# Installs Debian packages on a CI runner without letting a slow mirror run out the job's time (CI only; nothing here ships).
#
#   [APT_ARCHIVES=dir] [APT_DOWNLOAD_SECONDS=n] [APT_DOWNLOAD_ATTEMPTS=n] bash tools/ci/apt-install.sh [package...]
#
# apt is told to retry a failed fetch, and Ubuntu's own archive is added after the runner's mirror, so a fetch that dies is tried
# again or elsewhere. A mirror that trickles bytes does not die, so the packages are first downloaded under a time limit, and a
# download that runs out of time is started again (it can be stopped safely: nothing is installed yet, and the next attempt goes
# on from the partial file). Then they are installed from what was downloaded. APT_ARCHIVES names a folder the job keeps between
# runs (actions/cache), so a run whose packages are already there needs no mirror at all; apt checks each kept file against the
# signed package index before it uses it. With no packages, only the retry setting and the fallback mirror are written, for a later
# step that runs apt itself (playwright install --with-deps).
set -euo pipefail

echo 'Acquire::Retries "5"; Acquire::http::Timeout "30"; Acquire::https::Timeout "30";' | sudo tee /etc/apt/apt.conf.d/80-ci-retries
# The runner reads its archive from a mirror list (mirror+file:); a mirror that fails a fetch hands it to the next one.
if [ -f /etc/apt/apt-mirrors.txt ] && ! grep -q '^http://archive.ubuntu.com/ubuntu/' /etc/apt/apt-mirrors.txt; then
  echo 'http://archive.ubuntu.com/ubuntu/' | sudo tee -a /etc/apt/apt-mirrors.txt
fi
[ "$#" -eq 0 ] && exit 0

# man-db rebuilds its index after every package by default, which alone can outlast a job; no job needs it.
sudo rm -f /var/lib/man-db/auto-update

archives=()
if [ -n "${APT_ARCHIVES:-}" ]; then
  mkdir -p "$APT_ARCHIVES/partial"
  archives=(-o "Dir::Cache::archives=$APT_ARCHIVES")
  echo "Kept packages in $APT_ARCHIVES: $(find "$APT_ARCHIVES" -maxdepth 1 -name '*.deb' | wc -l)"
fi

limit="${APT_DOWNLOAD_SECONDS:-300}"
attempts="${APT_DOWNLOAD_ATTEMPTS:-4}"
for attempt in $(seq 1 "$attempts"); do
  if sudo timeout "$limit" apt-get update && sudo timeout "$limit" apt-get install -y --download-only --no-install-recommends "${archives[@]}" "$@"; then
    break
  fi
  if [ "$attempt" = "$attempts" ]; then
    echo "::error::The packages could not be downloaded in ${attempts} attempts of ${limit} seconds each."
    exit 1
  fi
  echo "::warning::Downloading the packages did not finish within ${limit} seconds (attempt ${attempt}); trying again."
done
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${archives[@]}" "$@"
