#!/bin/bash
set -eu

# Mosquitto has no environment-variable expansion, but the go-auth plugin needs
# the shared secret written inline in its config. Render the template at start
# so MQTT_AUTH_INTERNAL_SECRET lives in .env rather than in git.

TEMPLATE=/mosquitto/config/mosquitto.conf.template
RENDERED=/mosquitto/config/mosquitto.conf

if [ ! -f "$TEMPLATE" ]; then
  echo "FATAL: $TEMPLATE not found — is the template mounted?" >&2
  exit 1
fi

if [ -z "${MQTT_AUTH_INTERNAL_SECRET:-}" ]; then
  # Failing loudly beats starting a broker whose auth callbacks the API will
  # reject on every single connection.
  echo "FATAL: MQTT_AUTH_INTERNAL_SECRET is not set." >&2
  echo "       The API refuses auth requests without it, so every client" >&2
  echo "       would be denied. Set it in .env and restart." >&2
  exit 1
fi

if [ -z "${API_INTERNAL_HOST:-}" ] || [ -z "${API_INTERNAL_PORT:-}" ]; then
  # The auth plugin POSTs every connect, publish and subscribe to the API at
  # this address. A wrong or missing value doesn't fail the broker — it makes
  # the broker deny every client, which is far harder to diagnose from the
  # driver app than a refusal to start.
  echo "FATAL: API_INTERNAL_HOST / API_INTERNAL_PORT are not both set." >&2
  echo "       These point the auth plugin at the API: the 'api' service on" >&2
  echo "       compose, or the API's Service Connect name on ECS. Without" >&2
  echo "       them every driver connection would be refused." >&2
  exit 1
fi

# Substitute only these three, so a literal '$' anywhere else in the config
# survives untouched.
#
# Bash string replacement rather than envsubst: gettext is not in the base
# image, and it cannot be apt-installed there — the image is Debian bullseye
# but its sources say "stable", which has since become trixie, so apt refuses
# the codename change. Pulling trixie packages into a bullseye image would
# risk a libc mismatch, and this needs no package at all.
#
# The replacements MUST stay double-quoted. Since bash 5.2 an unquoted '&' in
# a pattern substitution expands to the matched text, exactly as in sed — so
# an unquoted form silently corrupts any secret containing '&', turning it
# into the literal string '${MQTT_AUTH_INTERNAL_SECRET}'. Quoting makes '&'
# literal, and there is no delimiter to collide with as there would be in sed.
render=$(cat "$TEMPLATE")
render=${render//'${MQTT_AUTH_INTERNAL_SECRET}'/"$MQTT_AUTH_INTERNAL_SECRET"}
render=${render//'${API_INTERNAL_HOST}'/"$API_INTERNAL_HOST"}
render=${render//'${API_INTERNAL_PORT}'/"$API_INTERNAL_PORT"}
printf '%s\n' "$render" > "$RENDERED"

# Catch a template variable nobody substituted, rather than letting mosquitto
# try to reach a host literally named "${API_INTERNAL_HOST}".
if grep -q '\${' "$RENDERED"; then
  echo "FATAL: unsubstituted variables remain in the rendered config:" >&2
  grep -n '\${' "$RENDERED" >&2
  exit 1
fi

echo "Rendered mosquitto.conf from template."

# Hand the writable paths to the mosquitto user before starting. The config
# mounts are read-only, so only data/ and log/ are chowned.
chown mosquitto:mosquitto "$RENDERED" 2>/dev/null || true
chown -R mosquitto:mosquitto /mosquitto/data /mosquitto/log 2>/dev/null || true

# Started as root, mosquitto drops to the account named by the `user` directive
# in the config (set to `mosquitto` there) before serving any traffic. Doing it
# that way avoids depending on su-exec, which is not guaranteed to exist in the
# base image — a missing binary here would fail the container on first boot.
exec /usr/sbin/mosquitto -c "$RENDERED"
