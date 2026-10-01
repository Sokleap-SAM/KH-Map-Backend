# Valhalla with Cambodia tiles baked in.
#
# The compose setup builds tiles from the .osm.pbf on first start, which is
# why its healthcheck allows a 120 s start_period and why it needs a
# persistent volume. Neither works well on ECS: every task start would rebuild
# (minutes of CPU, and a cold task serving nothing), or every task would need
# an EFS mount shared with the tile builder.
#
# Instead the tiles are built ONCE, by hand, and shipped inside the image.
# See build-tiles.sh in this directory, and DEPLOY.md, for how to rebuild them
# when the PBF is refreshed.

FROM ghcr.io/gis-ops/docker-valhalla/valhalla:latest

# Only what serving needs:
#   valhalla_tiles.tar — the `tile_extract` from valhalla.json. Valhalla mmaps
#     this and ignores the loose valhalla_tiles/ directory when it exists, so
#     the directory (another ~89 MB) is deliberately NOT copied.
#   admins.sqlite / timezones.sqlite — referenced by absolute path in
#     valhalla.json for admin and time-zone lookups.
# The .osm.pbf is NOT copied: it is only an input to the tile build, and
# leaving it out keeps ~38 MB out of every task pull.
COPY custom_files/valhalla.json               /custom_files/valhalla.json
COPY custom_files/valhalla_tiles.tar          /custom_files/valhalla_tiles.tar
COPY custom_files/admin_data/admins.sqlite    /custom_files/admin_data/admins.sqlite
COPY custom_files/timezone_data/timezones.sqlite /custom_files/timezone_data/timezones.sqlite

# Never rebuild at runtime — the tiles above are the whole point. With no PBF
# present, a rebuild would produce an empty graph and route nothing.
ENV force_rebuild=False \
    use_tiles_ignore_pbf=True \
    build_elevation=False \
    build_admins=False \
    build_time_zones=False \
    tile_urls= \
    server_threads=4

EXPOSE 8002

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD curl -fsS http://localhost:8002/status || exit 1
