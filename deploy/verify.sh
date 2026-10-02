#!/usr/bin/env bash
#
# Post-deploy verification. Read-only — creates and changes nothing.
#
#   ./deploy/verify.sh
#
# Uses the real domain once DNS resolves, and falls back to the ALB's own name
# with a Host header and -k before then, so it is useful at both stages.
#
# Exits non-zero if any check fails, so it can gate a deploy.
set -uo pipefail

AWS_REGION="${AWS_REGION:-ap-southeast-1}"
CLUSTER="${CLUSTER:-khmap}"
DOMAIN="${DOMAIN:-kh-map.online}"
WINDOW="${WINDOW:-5m}"

PASS=0; FAIL=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
info() { printf '        %s\n' "$1"; }
say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ─── 1. Services ─────────────────────────────────────────────────────────────
say "ECS services"
for s in khmap-redis khmap-valhalla khmap-api khmap-mosquitto; do
  read -r running desired < <(aws ecs describe-services --cluster "$CLUSTER" --services "$s" \
    --query 'services[0].[runningCount,desiredCount]' --output text 2>/dev/null)
  if [ "${running:-0}" = "${desired:-x}" ] && [ "${running:-0}" != "0" ]; then
    ok "$s  $running/$desired running"
  else
    bad "$s  ${running:-?}/${desired:-?} running"
  fi
done

# ─── 2. Target groups ────────────────────────────────────────────────────────
say "Load balancer targets"
for tg in khmap-tg-api khmap-tg-mqtt-rider khmap-tg-mqtt-driver; do
  arn=$(aws elbv2 describe-target-groups --names "$tg" \
    --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null)
  states=$(aws elbv2 describe-target-health --target-group-arn "$arn" \
    --query 'TargetHealthDescriptions[].TargetHealth.State' --output text 2>/dev/null)
  # Two subtleties:
  #  - "unhealthy" contains "healthy", so the match must be whole-line (-x)
  #  - `--output text` separates multiple targets with TABS, so splitting on
  #    spaces alone leaves "healthy<tab>healthy" as a single unmatched line
  if [ -n "$states" ] &&
     ! tr '[:space:]' '\n' <<<"$states" | grep -v '^$' | grep -qvx healthy; then
    ok "$tg  $states"
  else
    bad "$tg  ${states:-no targets registered}"
  fi
done

# ─── 3. Restart loops ────────────────────────────────────────────────────────
# "Rendered mosquitto.conf from template" prints once per container start, so
# more than one in the window means the broker is being killed and replaced —
# usually a failing container health check.
say "Stability (last $WINDOW)"
starts=$(aws logs tail /ecs/khmap-mosquitto --since "$WINDOW" --format short 2>/dev/null \
  | grep -c 'Rendered mosquitto.conf')
if [ "${starts:-9}" -le 1 ]; then ok "broker not restarting ($starts start(s))"
else bad "broker restarted $starts times — check its container health check"; fi

# Anonymous probes against 1883 mean something is still connecting without
# credentials to a listener that requires them.
anon=$(aws logs tail /ecs/khmap-mosquitto --since "$WINDOW" --format short 2>/dev/null \
  | grep -c 'received null username')
if [ "${anon:-9}" -eq 0 ]; then ok "no unauthenticated probes on 1883"
else bad "$anon unauthenticated connection attempts on 1883"; fi

# The API should connect once per task and stay connected. Repeated closes are
# the signature of two tasks sharing an MQTT client id.
closes=$(aws logs tail /ecs/khmap-api --since "$WINDOW" --format short 2>/dev/null \
  | grep -c 'connection closed')
if [ "${closes:-9}" -le 1 ]; then ok "API MQTT link stable ($closes close(s))"
else bad "API MQTT reconnecting $closes times — duplicate client id?"; fi

# A healthy long-lived connection logs NOTHING: MqttService only writes on
# connect, close or error. So "no subscribe in this window" is ambiguous — it
# means either never subscribed, or subscribed before the window opened and
# stayed up since. The second is the better state, and an earlier version of
# this check reported it as a failure.
#
# Treat it as healthy only when there is also no close and no error in the
# window, i.e. nothing happened because nothing went wrong.
errs=$(aws logs tail /ecs/khmap-api --since "$WINDOW" --format short 2>/dev/null \
  | grep -c 'MQTT connection error')
if aws logs tail /ecs/khmap-api --since "$WINDOW" --format short 2>/dev/null \
   | grep -q 'Subscribed to "driver/+/location"'; then
  ok 'API subscribed to driver/+/location'
elif [ "${closes:-9}" -eq 0 ] && [ "${errs:-9}" -eq 0 ]; then
  ok 'API MQTT quiet — connection predates this window and has not dropped'
else
  bad 'API not subscribed to driver/+/location, and the link is unstable'
fi

# ─── 4. HTTP ─────────────────────────────────────────────────────────────────
ALB=$(aws elbv2 describe-load-balancers --names khmap-alb \
  --query 'LoadBalancers[0].DNSName' --output text 2>/dev/null)
if host "api.$DOMAIN" >/dev/null 2>&1 || nslookup "api.$DOMAIN" >/dev/null 2>&1; then
  BASE="https://api.$DOMAIN"; CURL=(curl -sS --max-time 15)
  say "HTTP via $BASE (DNS resolves — real certificate in use)"
else
  BASE="https://$ALB"; CURL=(curl -sS -k --max-time 15 -H "Host: api.$DOMAIN")
  say "HTTP via $ALB (DNS not resolving yet — Host header + -k)"
fi

body=$("${CURL[@]}" "$BASE/health" 2>/dev/null)
grep -q '"status":"ok"' <<<"$body" && ok "/health  $body" || bad "/health  ${body:-no response}"

body=$("${CURL[@]}" "$BASE/health/ready" 2>/dev/null)
if grep -q '"mongo":"up"' <<<"$body" && grep -q '"redis":"up"' <<<"$body"; then
  ok "/health/ready  $body"
else
  bad "/health/ready  ${body:-no response}"
fi

# The single most security-relevant check: these are the broker's auth
# callbacks, and a 403 here is the ALB rule holding. Anything else means the
# rule is missing or ordered after the API host rule, and anyone can probe
# driver credentials against bcrypt.
code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/internal/mqtt-auth/user" 2>/dev/null)
[ "$code" = "403" ] && ok "/internal/* blocked (403)" || bad "/internal/* returned $code, expected 403"

body=$("${CURL[@]}" "$BASE/transit/plan?originLng=104.92&originLat=11.55&destLng=104.89&destLat=11.57&type=walk" 2>/dev/null)
grep -q '"found":true' <<<"$body" && ok "routing works (API -> Valhalla)" \
  || bad "routing failed: $(head -c 120 <<<"${body:-no response}")"

# ─── Summary ─────────────────────────────────────────────────────────────────
say "$PASS passed, $FAIL failed"
if [ "$FAIL" -eq 0 ]; then
  cat <<'NEXT'
  Infrastructure verified. Remaining:
    - CNAME records for api / mqtt / driver-mqtt (if not done)
    - rider + driver wss paths:
        URL=wss://mqtt.kh-map.online:443        TOPIC='transit/#' node deploy/ws-probe.js   # GRANTED
        URL=wss://driver-mqtt.kh-map.online:443 TOPIC='transit/#' node deploy/ws-probe.js   # REFUSED
NEXT
fi
exit $(( FAIL > 0 ? 1 : 0 ))
