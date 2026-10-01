#!/usr/bin/env bash
#
# Registers the task definitions and creates the four ECS services, in
# dependency order. Run AFTER bootstrap-aws.sh and create-alb.sh.
#
#   IMAGE_TAG=v1 ./deploy/create-services.sh
#
# Order matters on a first deploy:
#   redis + valhalla   nothing depends on them, and the API's health check
#                      reports degraded without redis
#   api                must answer before the broker starts, because the
#                      broker's auth plugin calls back into it on every
#                      connect — without the API it denies every client
#   mosquitto          last
#
# Safe to re-run: an existing service is updated rather than recreated.
set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-southeast-1}"
CLUSTER="${CLUSTER:-khmap}"
NAMESPACE="${NAMESPACE:-khmap.local}"
IMAGE_TAG="${IMAGE_TAG:-v1}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
have() { [ -n "${1:-}" ] && [ "$1" != "None" ]; }

cd "$(dirname "$0")/.."

# ─── Inputs ──────────────────────────────────────────────────────────────────
say "Prerequisites"
VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
SUBNET_CSV=$(aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC_ID" \
  --query 'Subnets[].SubnetId' --output text | tr '\t' ',')
TASK_SG=$(aws ec2 describe-security-groups --filters Name=vpc-id,Values="$VPC_ID" \
  Name=group-name,Values=khmap-task-sg --query 'SecurityGroups[0].GroupId' --output text)
tg() { aws elbv2 describe-target-groups --names "$1" --query 'TargetGroups[0].TargetGroupArn' --output text; }
TG_API=$(tg khmap-tg-api)
TG_RIDER=$(tg khmap-tg-mqtt-rider)
TG_DRIVER=$(tg khmap-tg-mqtt-driver)
have "$TASK_SG" || { echo "  khmap-task-sg missing — run bootstrap-aws.sh" >&2; exit 1; }
have "$TG_API"  || { echo "  target groups missing — run create-alb.sh" >&2; exit 1; }
echo "  subnets=$SUBNET_CSV"
echo "  task sg=$TASK_SG"

# assignPublicIp=ENABLED is required here. These are public subnets with no NAT
# gateway, and a Fargate task with no public IP cannot reach ECR or Secrets
# Manager — it fails at startup with ResourceInitializationError, which reads
# like a permissions problem rather than a networking one.
NETCFG="awsvpcConfiguration={subnets=[$SUBNET_CSV],securityGroups=[$TASK_SG],assignPublicIp=ENABLED}"

# ─── Register task definitions ───────────────────────────────────────────────
# IMAGE_TAG is substituted here, not committed. CI does the same with the
# commit SHA; baking a tag into the repo would make that substitution a no-op.
# The task definitions are committed as templates — this repo is public, so no
# account or resource ids live in git. Local values come from deploy/.env.aws,
# which the .env.* rule already ignores. Create it once:
#
#   ACCOUNT_ID=123456789012
#   REGION=ap-southeast-1
#   EFS_ID=fs-xxxxxxxxxxxx
#   EFS_ACCESS_POINT_ID=fsap-xxxxxxxxxxxx
#
# CI does the same substitution from GitHub secrets, so neither path needs the
# repo to carry them.
if [ -f deploy/.env.aws ]; then
  # shellcheck disable=SC1091
  . deploy/.env.aws
  echo "  loaded deploy/.env.aws"
fi
ACCOUNT_ID="${ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
REGION="${REGION:-$AWS_REGION}"
for v in ACCOUNT_ID REGION EFS_ID EFS_ACCESS_POINT_ID; do
  [ -n "${!v:-}" ] || { echo "  $v is unset — add it to deploy/.env.aws" >&2; exit 1; }
done

say "Registering task definitions (image tag: $IMAGE_TAG)"
declare -A TD
for f in redis valhalla api mosquitto; do
  sed -e "s/IMAGE_TAG/$IMAGE_TAG/g" \
      -e "s/<ACCOUNT_ID>/$ACCOUNT_ID/g" \
      -e "s/<REGION>/$REGION/g" \
      -e "s/<EFS_ID>/$EFS_ID/g" \
      -e "s/<EFS_ACCESS_POINT_ID>/$EFS_ACCESS_POINT_ID/g" \
      "deploy/taskdef-$f.json" > "/tmp/td-$f.json"
  # Catch a placeholder nobody substituted before AWS rejects it with a
  # message that points at the ARN rather than at the missing value.
  if grep -q '<[A-Z_]*>' "/tmp/td-$f.json"; then
    echo "  unsubstituted placeholders in $f:" >&2
    grep -o '<[A-Z_]*>' "/tmp/td-$f.json" | sort -u | sed 's/^/    /' >&2
    exit 1
  fi
  TD[$f]=$(aws ecs register-task-definition --cli-input-json "file:///tmp/td-$f.json" \
    --query 'taskDefinition.taskDefinitionArn' --output text)
  echo "  $f -> ${TD[$f]##*/}"
  rm -f "/tmp/td-$f.json"
done

# ─── Services ────────────────────────────────────────────────────────────────
# Service Connect permits exactly ONE clientAlias per service, and that alias is
# the only name that resolves: khmap.local is an HTTP namespace, which carries
# no DNS records of its own. So the alias must be the fully-qualified form the
# task definitions already use — MQTT_URL is mqtt://mosquitto.khmap.local:1883,
# VALHALLA_HOST is valhalla.khmap.local, and so on. A bare "mosquitto" here
# would resolve nowhere.
sc_config() { # portName discoveryName port
  cat <<JSON
{
  "enabled": true,
  "namespace": "$NAMESPACE",
  "services": [{
    "portName": "$1",
    "discoveryName": "$2",
    "clientAliases": [
      { "port": $3, "dnsName": "$2.$NAMESPACE" }
    ]
  }]
}
JSON
}

create_or_update() { # name taskdef desiredCount scJson [lbArgs...]
  local name=$1 td=$2 count=$3 sc=$4; shift 4
  local existing
  existing=$(aws ecs describe-services --cluster "$CLUSTER" --services "$name" \
    --query 'services[?status!=`INACTIVE`].serviceName | [0]' --output text 2>/dev/null || echo None)
  if have "$existing"; then
    aws ecs update-service --cluster "$CLUSTER" --service "$name" \
      --task-definition "$td" --desired-count "$count" >/dev/null
    echo "  $name updated"
  else
    aws ecs create-service --cluster "$CLUSTER" --service-name "$name" \
      --task-definition "$td" --desired-count "$count" \
      --launch-type FARGATE --network-configuration "$NETCFG" \
      --service-connect-configuration "$sc" "$@" >/dev/null
    echo "  $name created"
  fi
}

wait_stable() {
  echo "  waiting for $1 to stabilise ..."
  aws ecs wait services-stable --cluster "$CLUSTER" --services "$1"
  echo "  $1 stable"
}

say "redis + valhalla"
create_or_update khmap-redis    "${TD[redis]}"    1 "$(sc_config redis redis 6379)"
create_or_update khmap-valhalla "${TD[valhalla]}" 1 "$(sc_config valhalla valhalla 8002)"
wait_stable khmap-redis
wait_stable khmap-valhalla

say "api"
create_or_update khmap-api "${TD[api]}" 2 "$(sc_config api api 3000)" \
  --load-balancers "targetGroupArn=$TG_API,containerName=api,containerPort=3000" \
  --health-check-grace-period-seconds 60
wait_stable khmap-api

# Exactly one task, always. A second broker splits session state and retained
# messages, and the EFS access point is single-writer in practice. maximumPercent
# 100 stops ECS starting a replacement before the old one has gone.
say "mosquitto (single task, by design)"
create_or_update khmap-mosquitto "${TD[mosquitto]}" 1 "$(sc_config mqtt-tcp mosquitto 1883)" \
  --load-balancers \
    "targetGroupArn=$TG_RIDER,containerName=mosquitto,containerPort=9001" \
    "targetGroupArn=$TG_DRIVER,containerName=mosquitto,containerPort=9002" \
  --deployment-configuration "maximumPercent=100,minimumHealthyPercent=0" \
  --health-check-grace-period-seconds 60
wait_stable khmap-mosquitto

# ─── Summary ─────────────────────────────────────────────────────────────────
DNS=$(aws elbv2 describe-load-balancers --names khmap-alb \
  --query 'LoadBalancers[0].DNSName' --output text)
say "Done"
aws ecs list-services --cluster "$CLUSTER" --query 'serviceArns' --output text | tr '\t' '\n' | sed 's|.*/|  |'
cat <<SUMMARY

  Target group health (all should become healthy within ~2 min):
    aws elbv2 describe-target-health --target-group-arn $TG_API \\
      --query 'TargetHealthDescriptions[].TargetHealth.State' --output text

  Smoke tests, before DNS exists (Host header + -k):
    curl -k -H "Host: api.kh-map.online" https://$DNS/health
    curl -k -o /dev/null -w '%{http_code}\\n' -H "Host: api.kh-map.online" \\
      https://$DNS/internal/mqtt-auth/user        # must stay 403

  Then add the three CNAME records pointing at: $DNS
SUMMARY
