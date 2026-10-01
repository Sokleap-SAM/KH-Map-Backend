#!/usr/bin/env bash
#
# Rebuild the Valhalla tiles that valhalla/Dockerfile bakes into the image.
#
# Run this ONLY when the OSM extract changes — not on every deploy. It takes
# minutes and needs several GB of RAM. Everything it produces lands in
# custom_files/, which the image build then copies from.
#
#   ./valhalla/build-tiles.sh valhalla/custom_files/cambodia-260516.osm.pbf
#
# Afterwards, rebuild and push the image:
#   docker build -t <ecr>/khmap-valhalla:<tag> valhalla/
set -euo pipefail

PBF="${1:-}"
if [ -z "$PBF" ] || [ ! -f "$PBF" ]; then
  echo "usage: $0 <path-to.osm.pbf>" >&2
  echo "download Cambodia from https://download.geofabrik.de/asia/cambodia-latest.osm.pbf" >&2
  exit 1
fi

CUSTOM_FILES="$(cd "$(dirname "$0")" && pwd)/custom_files"
mkdir -p "$CUSTOM_FILES"

# Keep the PBF alongside the other inputs; the builder only looks in /custom_files.
if [ "$(cd "$(dirname "$PBF")" && pwd)" != "$CUSTOM_FILES" ]; then
  cp "$PBF" "$CUSTOM_FILES/"
fi

# force_rebuild=True is the whole point of this script. build_tar=True writes
# valhalla_tiles.tar, which is the `tile_extract` the served image reads.
docker run --rm \
  -v "$CUSTOM_FILES:/custom_files" \
  -e force_rebuild=True \
  -e build_tar=True \
  -e build_elevation=False \
  -e build_admins=True \
  -e build_time_zones=True \
  -e use_tiles_ignore_pbf=False \
  -e tile_urls= \
  ghcr.io/gis-ops/docker-valhalla/valhalla:latest \
  /bin/bash -c "/valhalla/scripts/configure_valhalla.sh && echo 'tile build complete'"

echo
echo "Built into $CUSTOM_FILES:"
ls -la "$CUSTOM_FILES/valhalla_tiles.tar" \
       "$CUSTOM_FILES/admin_data/admins.sqlite" \
       "$CUSTOM_FILES/timezone_data/timezones.sqlite"
echo
echo "Next: docker build -t <ecr-repo>/khmap-valhalla:<tag> $(dirname "$CUSTOM_FILES")"
