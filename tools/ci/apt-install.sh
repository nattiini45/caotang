#!/usr/bin/env bash
# Installs Debian packages on a CI runner without letting a slow mirror run out the job's time (CI only; nothing here ships).
#
#   bash tools/ci/apt-install.sh [package...]
#
# apt is told to retry a failed fetch, which covers a fetch that dies. A mirror that trickles bytes does not die, so the
# packages are first downloaded under a time limit, and a download that runs out of time is started again (it can be stopped
# safely: nothing is installed yet). Then they are installed from the local cache. With no packages, only the retry setting
# is written, for a later step that runs apt itself (playwright install --with-deps).
set -euo pipefail

echo 'Acquire::Retries "5"; Acquire::http::Timeout "30"; Acquire::https::Timeout "30";' | sudo tee /etc/apt/apt.conf.d/80-ci-retries
[ "$#" -eq 0 ] && exit 0

# man-db rebuilds its index after every package by default, which alone can outlast a job; no job needs it.
sudo rm -f /var/lib/man-db/auto-update

limit="${APT_DOWNLOAD_SECONDS:-300}"
for attempt in 1 2 3; do
  if sudo timeout "$limit" apt-get update && sudo timeout "$limit" apt-get install -y --download-only --no-install-recommends "$@"; then
    break
  fi
  if [ "$attempt" = 3 ]; then
    echo "::error::The packages could not be downloaded in three attempts of ${limit} seconds each."
    exit 1
  fi
  echo "::warning::Downloading the packages did not finish within ${limit} seconds (attempt ${attempt}); trying again."
done
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
