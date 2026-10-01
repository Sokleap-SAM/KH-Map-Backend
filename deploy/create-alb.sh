#!/usr/bin/env bash
#
# Creates the load balancer, its three target groups, and the listener rules.
# Run AFTER deploy/bootstrap-aws.sh and after the ACM certificate is ISSUED.
#
#   ./deploy/create-alb.sh
#
# Safe to re-run: each resource is looked up before being created.
#
# Prints the ALB DNS name at the end — that is what your three CNAME records
# at the registrar point at.
set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-southeast-1}"
DOMAIN="${DOMAIN:-kh-map.online}"
ALB_NAME="${ALB_NAME:-khmap-alb}"
# Must exceed MQTT_KEEPALIVE (60s) or the ALB closes idle WebSockets between
# client pings, which drivers see as the broker randomly disconnecting them.
IDLE_TIMEOUT="${IDLE_TIMEOUT:-120}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
have() { [ -n "${1:-}" ] && [ "$1" != "None" ]; }

# ─── Inputs ──────────────────────────────────────────────────────────────────
say "Looking up prerequisites"
VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
SUBNETS=$(aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC_ID" --query 'Subnets[].SubnetId' --output text)
ALB_SG=$(aws ec2 describe-security-groups --filters Name=vpc-id,Values="$VPC_ID" \
  Name=group-name,Values=khmap-alb-sg --query 'SecurityGroups[0].GroupId' --output text)
CERT_ARN=$(aws acm list-certificates --region "$AWS_REGION" \
  --query "CertificateSummaryList[?DomainName=='$DOMAIN' || DomainName=='*.$DOMAIN'].CertificateArn | [0]" \
  --output text)

have "$ALB_SG"   || { echo "  khmap-alb-sg missing — run bootstrap-aws.sh first" >&2; exit 1; }
have "$CERT_ARN" || { echo "  no ACM certificate for $DOMAIN in $AWS_REGION" >&2; exit 1; }
STATUS=$(aws acm describe-certificate --region "$AWS_REGION" --certificate-arn "$CERT_ARN" \
  --query 'Certificate.Status' --output text)
[ "$STATUS" = "ISSUED" ] || { echo "  certificate is $STATUS, not ISSUED" >&2; exit 1; }
echo "  vpc=$VPC_ID"
echo "  subnets=$SUBNETS"
echo "  cert=$CERT_ARN"

# ─── Load balancer ───────────────────────────────────────────────────────────
say "Load balancer"
ALB_ARN=$(aws elbv2 describe-load-balancers --names "$ALB_NAME" \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || echo None)
if have "$ALB_ARN"; then
  echo "  exists"
else
  ALB_ARN=$(aws elbv2 create-load-balancer --name "$ALB_NAME" \
    --type application --scheme internet-facing \
    --subnets $SUBNETS --security-groups "$ALB_SG" \
    --query 'LoadBalancers[0].LoadBalancerArn' --output text)
  echo "  created"
fi
aws elbv2 modify-load-balancer-attributes --load-balancer-arn "$ALB_ARN" \
  --attributes Key=idle_timeout.timeout_seconds,Value=$IDLE_TIMEOUT >/dev/null
echo "  idle timeout ${IDLE_TIMEOUT}s"

# ─── Target groups ───────────────────────────────────────────────────────────
# target-type ip is REQUIRED for Fargate: awsvpc tasks register by ENI address,
# not instance id.
#
# The two MQTT groups health-check with a plain HTTP GET, which mosquitto's
# websocket listener answers with a 4xx because it is not a WebSocket upgrade.
# That is a healthy answer here — it proves the listener is accepting
# connections and speaking HTTP. Hence the wide matcher; only 5xx or a timeout
# should mark it unhealthy.
say "Target groups"
make_tg() { # name port matcher healthpath
  local arn
  arn=$(aws elbv2 describe-target-groups --names "$1" \
    --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || echo None)
  if have "$arn"; then echo "$arn"; return; fi
  aws elbv2 create-target-group --name "$1" \
    --protocol HTTP --port "$2" --vpc-id "$VPC_ID" --target-type ip \
    --health-check-protocol HTTP --health-check-path "$4" \
    --matcher "HttpCode=$3" \
    --health-check-interval-seconds 30 --health-check-timeout-seconds 5 \
    --healthy-threshold-count 2 --unhealthy-threshold-count 3 \
    --query 'TargetGroups[0].TargetGroupArn' --output text
}

# /health is liveness only and does no dependency I/O — deliberately NOT
# /health/ready, which returns 503 when Mongo or Redis blips and would drain
# healthy tasks during a transient outage.
TG_API=$(make_tg khmap-tg-api 3000 200 /health)
TG_RIDER=$(make_tg khmap-tg-mqtt-rider 9001 200-499 /)
TG_DRIVER=$(make_tg khmap-tg-mqtt-driver 9002 200-499 /)
echo "  api=$TG_API"
echo "  rider=$TG_RIDER"
echo "  driver=$TG_DRIVER"

# The default deregistration delay is 300s. The broker service runs exactly one
# task with maximumPercent=100, so ECS will not start the replacement until the
# old one has fully drained — meaning every broker deploy is a five-minute
# outage at the default. MQTT clients reconnect on their own and there is no
# in-flight request to protect, so 30s is plenty.
#
# The API group keeps the default: there, draining genuinely protects requests
# mid-flight, and with two tasks it costs no downtime.
for t in "$TG_RIDER" "$TG_DRIVER"; do
  aws elbv2 modify-target-group-attributes --target-group-arn "$t" \
    --attributes Key=deregistration_delay.timeout_seconds,Value=30 >/dev/null
done
echo "  MQTT groups: deregistration delay 30s (API left at default)"

# ─── Listeners ───────────────────────────────────────────────────────────────
say "Listeners"
HTTPS_ARN=$(aws elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" \
  --query "Listeners[?Port==\`443\`].ListenerArn | [0]" --output text 2>/dev/null || echo None)
if have "$HTTPS_ARN"; then
  echo "  443 exists"
else
  # Default action is a 404: a request whose Host matches none of the rules
  # below should get nothing, rather than silently landing on the API.
  HTTPS_ARN=$(aws elbv2 create-listener --load-balancer-arn "$ALB_ARN" \
    --protocol HTTPS --port 443 --certificates CertificateArn="$CERT_ARN" \
    --ssl-policy ELBSecurityPolicy-TLS13-1-2-2021-06 \
    --default-actions 'Type=fixed-response,FixedResponseConfig={StatusCode=404,ContentType=text/plain,MessageBody=no route}' \
    --query 'Listeners[0].ListenerArn' --output text)
  echo "  443 created"
fi

HTTP_ARN=$(aws elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" \
  --query "Listeners[?Port==\`80\`].ListenerArn | [0]" --output text 2>/dev/null || echo None)
if ! have "$HTTP_ARN"; then
  aws elbv2 create-listener --load-balancer-arn "$ALB_ARN" \
    --protocol HTTP --port 80 \
    --default-actions 'Type=redirect,RedirectConfig={Protocol=HTTPS,Port=443,StatusCode=HTTP_301}' >/dev/null
  echo "  80 created (redirects to 443)"
else
  echo "  80 exists"
fi

# ─── Rules ───────────────────────────────────────────────────────────────────
# ORDER MATTERS. Priority 10 blocks /internal/* on EVERY host and is evaluated
# before the API host rule at 20. Reverse them and the broker's auth callbacks
# become reachable from the internet, where anyone could probe driver
# credentials against bcrypt — and nothing would appear broken.
#
# The path rule is deliberately NOT host-scoped, so hitting the ALB by its own
# DNS name is blocked too.
say "Listener rules"
rule_exists() { aws elbv2 describe-rules --listener-arn "$HTTPS_ARN" \
  --query "Rules[?Priority=='$1'].RuleArn | [0]" --output text 2>/dev/null; }

add_rule() { # priority conditions-json actions-json description
  if have "$(rule_exists "$1")"; then echo "  priority $1 exists ($4)"; return; fi
  aws elbv2 create-rule --listener-arn "$HTTPS_ARN" --priority "$1" \
    --conditions "$2" --actions "$3" >/dev/null
  echo "  priority $1 -> $4"
}

add_rule 10 \
  '[{"Field":"path-pattern","PathPatternConfig":{"Values":["/internal/*"]}}]' \
  '[{"Type":"fixed-response","FixedResponseConfig":{"StatusCode":"403","ContentType":"text/plain","MessageBody":"forbidden"}}]' \
  "BLOCK /internal/* (all hosts)"

add_rule 20 \
  "[{\"Field\":\"host-header\",\"HostHeaderConfig\":{\"Values\":[\"api.$DOMAIN\"]}}]" \
  "[{\"Type\":\"forward\",\"TargetGroupArn\":\"$TG_API\"}]" \
  "api.$DOMAIN -> api:3000"

add_rule 30 \
  "[{\"Field\":\"host-header\",\"HostHeaderConfig\":{\"Values\":[\"mqtt.$DOMAIN\"]}}]" \
  "[{\"Type\":\"forward\",\"TargetGroupArn\":\"$TG_RIDER\"}]" \
  "mqtt.$DOMAIN -> mosquitto:9001 (riders, anonymous)"

add_rule 40 \
  "[{\"Field\":\"host-header\",\"HostHeaderConfig\":{\"Values\":[\"driver-mqtt.$DOMAIN\"]}}]" \
  "[{\"Type\":\"forward\",\"TargetGroupArn\":\"$TG_DRIVER\"}]" \
  "driver-mqtt.$DOMAIN -> mosquitto:9002 (drivers, authenticated)"

# ─── Summary ─────────────────────────────────────────────────────────────────
DNS=$(aws elbv2 describe-load-balancers --load-balancer-arns "$ALB_ARN" \
  --query 'LoadBalancers[0].DNSName' --output text)
say "Done"
cat <<SUMMARY
  ALB DNS      $DNS

  CNAME records to create at your registrar, all pointing at that name:
    api          -> $DNS
    mqtt         -> $DNS
    driver-mqtt  -> $DNS

  Target group ARNs, for the ECS service definitions:
    api          $TG_API
    mqtt-rider   $TG_RIDER
    mqtt-driver  $TG_DRIVER

  All three will show "unhealthy" until the ECS services register targets.

  Verify the block rule even before DNS exists (Host header + -k, because the
  certificate is for $DOMAIN rather than the ALB's own name):
    curl -k -o /dev/null -w '%{http_code}\\n' -H "Host: api.$DOMAIN" \\
      https://$DNS/internal/mqtt-auth/user      # must be 403
SUMMARY
