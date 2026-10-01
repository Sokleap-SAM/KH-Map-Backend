# Mosquitto with the mosquitto-go-auth plugin.
#
# The stock eclipse-mosquitto image ships no auth plugin, so the production
# config in mosquitto.prod.conf — which delegates every connect and publish to
# the API — cannot load without one.
#
# ─── Why this image is Debian-based, and not eclipse-mosquitto ───────────────
#
# This file used to compile the plugin against Alpine/musl so it would match
# eclipse-mosquitto:2. That cannot work, in either direction:
#
#   - Build on glibc, load into Alpine  -> dlopen fails, wrong libc.
#   - Build on musl,  load into Alpine  -> dlopen fails with
#       "Error relocating /mosquitto/go-auth.so: runtime.tlsg:
#        initial-exec TLS resolves to dynamic definition"
#
# The second is not a packaging mistake. Go's runtime requires initial-exec
# TLS, and musl's loader only provides that to libraries present at program
# start, not to ones dlopen'd afterwards. glibc reserves surplus static TLS
# for exactly this case; musl does not. A Go c-shared plugin therefore cannot
# be loaded by a musl-linked broker at all.
#
# Upstream reached the same conclusion: their Dockerfile is glibc end to end,
# building Mosquitto from source on Debian rather than using Alpine. Rather
# than duplicate that (libwebsockets + Mosquitto from source, several minutes
# per build), we start from the image they publish, which already contains a
# glibc Mosquitto and a matching plugin, and add only our config and entrypoint.
#
# The tag pins BOTH versions: plugin 2.1.0 — the version mosquitto.prod.conf's
# auth_opt_* settings were written against — and Mosquitto 2.0.15. Moving to
# 3.0.0 is a separate, testable change: it is a major plugin bump that may
# rename those settings.
#
# If depending on a third-party image is not acceptable, the alternative is to
# vendor upstream's builder stages into this file. That is a build-time cost,
# not a behavioural difference.
FROM iegomez/mosquitto-go-auth:2.1.0-mosquitto_2.0.15

# Deliberately no apt-get here.
#
# This image is Debian bullseye, but its sources.list says "stable" — which has
# since rolled to trixie, so `apt-get update` fails outright on the codename
# change. Repointing it at archive.debian.org would work, and pulling trixie
# packages into a bullseye userland would risk a libc mismatch; both are worse
# than not needing packages in the first place.
#
# So the two things that would have been installed are avoided instead:
#   envsubst -> docker-entrypoint.sh uses bash string replacement
#   curl     -> the healthcheck uses mosquitto_sub, already in this image
#
# That also keeps the build offline-capable and the image smaller.

# The upstream image keeps state in /var/lib/mosquitto; our config uses
# /mosquitto/data (persistence_location) and /mosquitto/log. Create both and
# hand them to the account mosquitto drops to, so persistence works on a fresh
# volume. The entrypoint re-applies this at start for mounted volumes.
RUN mkdir -p /mosquitto/config /mosquitto/data /mosquitto/log \
 && chown -R mosquitto:mosquitto /mosquitto/data /mosquitto/log

# Baked in because ECS has no bind mounts. docker-compose.prod.yml still
# mounts over both paths, so editing them locally needs no rebuild.
COPY mosquitto.prod.conf /mosquitto/config/mosquitto.conf.template
COPY anonymous.acl /mosquitto/config/anonymous.acl

# Served by both websockets listeners via http_dir. It exists only so the ALB
# health check has a real HTTP response to match: a websockets listener answers
# a non-upgrade GET by closing the connection with no HTTP status at all, so no
# matcher range can satisfy it and ECS kills the task as "failed ELB health
# checks" while the broker is perfectly healthy.
#
# The file is intentionally just "ok" -- it is publicly reachable at
# https://mqtt.<domain>/ and should not describe what sits behind it.
COPY www/ /mosquitto/www/

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 1883 9001 9002

# tini comes from the base image and is kept deliberately: it reaps zombies
# and forwards signals, which matters because the entrypoint execs mosquitto
# and it becomes the container's main process.
ENTRYPOINT ["/usr/bin/tini", "--", "/docker-entrypoint.sh"]
