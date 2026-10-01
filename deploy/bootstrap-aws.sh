#!/usr/bin/env bash
#
# One-time AWS bootstrap: everything the ECS services need to exist BEFORE any
# task definition can be registered. Creates nothing that costs money while
# idle except the EFS filesystem (pennies) and the Cloud Map namespace (free).
#
#   MOSQ_UID=<uid> MOSQ_GID=<gid> ./deploy/bootstrap-aws.sh
#
# Find the UID/GID first — the EFS access point pins them, and a mismatch means
# the broker starts fine but silently cannot write its persistence file:
#
#   docker run --rm --entrypoint id khmap-mqtt:test mosquitto
#
# Safe to re-run: every step checks for an existing resource first and skips it.
# Nothing here deletes anything.
#
# Deliberately uses the DEFAULT VPC. That is the right trade for a first
# deploy — a purpose-built VPC with private subnets and NAT gateways costs
# ~$32/month per AZ in NAT charges alone and changes none of what we are
# verifying. Revisit once the stack is proven.
set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-southeast-1}"
CLUSTER="${CLUSTER:-khmap}"
NAMESPACE="${NAMESPACE:-khmap.local}"
SECRET_NAME="${SECRET_NAME:-khmap/prod}"
MOSQ_UID="${MOSQ_UID:-}"
MOSQ_GID="${MOSQ_GID:-}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
have() { [ -n "${1:-}" ] && [ "$1" != "None" ]; }

# ─── 0. Identity ─────────────────────────────────────────────────────────────
say "Identity"
IDENT=$(aws sts get-caller-identity --query Arn --output text)
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "  $IDENT"
case "$IDENT" in
  *:root) echo "  REFUSING: you are signed in as root. Switch to an IAM user." >&2; exit 1 ;;
esac
echo "  account=$ACCOUNT region=$AWS_REGION"

# ─── 1. Secrets Manager ──────────────────────────────────────────────────────
# Built from .env.production so the values are not retyped. The two cross-checks
# below catch failures that are otherwise silent at runtime: a mismatched
# backend credential pair means the API is denied superuser and quietly stops
# publishing, and a short JWT_SECRET fails the production env schema at boot.
say "Secret: $SECRET_NAME"
if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
  echo "  exists — skipping (update with: aws secretsmanager put-secret-value)"
else
  node -e '
    const fs=require("fs"), dotenv=require("dotenv");
    const env=dotenv.parse(fs.readFileSync(".env.production","utf8"));
    const keys=["MONGODB_URI","JWT_SECRET","EMAIL_USER","EMAIL_PASS","REDIS_PASSWORD",
      "CLOUDINARY_API_KEY","CLOUDINARY_API_SECRET","MQTT_USERNAME","MQTT_PASSWORD",
      "MQTT_AUTH_INTERNAL_SECRET","MQTT_BACKEND_USERNAME","MQTT_BACKEND_PASSWORD"];
    const out={}, missing=[];
    for (const k of keys) env[k] ? out[k]=env[k] : missing.push(k);
    if (missing.length) { console.error("  MISSING: "+missing.join(", ")); process.exit(1); }
    if (out.MQTT_BACKEND_USERNAME!==out.MQTT_USERNAME || out.MQTT_BACKEND_PASSWORD!==out.MQTT_PASSWORD) {
      console.error("  MQTT_BACKEND_* must equal MQTT_USERNAME/MQTT_PASSWORD"); process.exit(1);
    }
    if (String(out.JWT_SECRET).length < 32) {
      console.error("  JWT_SECRET must be >= 32 chars in production"); process.exit(1);
    }
    fs.writeFileSync("/tmp/khmap-secret.json", JSON.stringify(out));
    console.log("  prepared "+Object.keys(out).length+" keys");
  '
  aws secretsmanager create-secret --name "$SECRET_NAME" \
    --description "kh-map backend runtime secrets" \
    --secret-string file:///tmp/khmap-secret.json >/dev/null
  rm -f /tmp/khmap-secret.json
  echo "  created"
fi
SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --query ARN --output text)

# ─── 2. IAM roles ────────────────────────────────────────────────────────────
# Execution role = what ECS uses to pull images and read secrets.
# Task role      = the API's own identity. Empty on purpose: when the app later
#                  needs S3 or SES you widen THIS, not the execution role, so
#                  infrastructure and application privileges stay separate.
say "IAM roles"
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
for role in khmapEcsTaskExecutionRole khmapApiTaskRole; do
  if aws iam get-role --role-name "$role" >/dev/null 2>&1; then
    echo "  $role exists"
  else
    aws iam create-role --role-name "$role" --assume-role-policy-document "$TRUST" >/dev/null
    echo "  $role created"
  fi
done
aws iam attach-role-policy --role-name khmapEcsTaskExecutionRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam put-role-policy --role-name khmapEcsTaskExecutionRole \
  --policy-name khmapSecretsRead \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"secretsmanager:GetSecretValue\",\"Resource\":\"$SECRET_ARN\"}]}"

# The task definitions set awslogs-create-group=true so the log groups appear
# on first run. AmazonECSTaskExecutionRolePolicy grants CreateLogStream and
# PutLogEvents but NOT CreateLogGroup, so without this every task dies at
# startup with "failed to validate logger args" — which reads like a logging
# misconfiguration rather than a missing permission.
aws iam put-role-policy --role-name khmapEcsTaskExecutionRole \
  --policy-name khmapCreateLogGroups \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"logs:CreateLogGroup\",\"Resource\":\"arn:aws:logs:$AWS_REGION:$ACCOUNT:log-group:/ecs/khmap-*\"}]}"
echo "  policies attached (secrets scoped to $SECRET_NAME, logs to /ecs/khmap-*)"

# The broker needs its OWN task role, separate from the API's. The EFS volume
# sets authorizationConfig.iam=ENABLED, and EFS then authorises the mount using
# the TASK role — not the execution role. Without it, registering the task
# definition fails outright with "EFS IAM authorization requires a task role".
if aws iam get-role --role-name khmapMosquittoTaskRole >/dev/null 2>&1; then
  echo "  khmapMosquittoTaskRole exists"
else
  aws iam create-role --role-name khmapMosquittoTaskRole \
    --assume-role-policy-document "$TRUST" >/dev/null
  echo "  khmapMosquittoTaskRole created"
fi

# ─── 3. Network + security groups ────────────────────────────────────────────
say "VPC and security groups"
VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
have "$VPC_ID" || { echo "  no default VPC — create one or set VPC_ID by hand" >&2; exit 1; }
SUBNETS=$(aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC_ID" \
  --query 'Subnets[].SubnetId' --output text)
echo "  vpc=$VPC_ID"
echo "  subnets=$SUBNETS"

sg_id() { aws ec2 describe-security-groups --filters Name=vpc-id,Values="$VPC_ID" \
  Name=group-name,Values="$1" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null; }
sg_make() {
  local id; id=$(sg_id "$1")
  if have "$id"; then echo "$id"; return; fi
  aws ec2 create-security-group --group-name "$1" --description "$2" \
    --vpc-id "$VPC_ID" --query GroupId --output text
}

ALB_SG=$(sg_make khmap-alb-sg "kh-map ALB: public 80/443")
TASK_SG=$(sg_make khmap-task-sg "kh-map ECS tasks")
EFS_SG=$(sg_make khmap-efs-sg "kh-map EFS mount targets")
echo "  alb=$ALB_SG task=$TASK_SG efs=$EFS_SG"

# Idempotent: AWS rejects duplicate rules, which we swallow.
rule() { aws ec2 authorize-security-group-ingress "$@" >/dev/null 2>&1 || true; }

# Public in, to the ALB only.
rule --group-id "$ALB_SG" --protocol tcp --port 80  --cidr 0.0.0.0/0
rule --group-id "$ALB_SG" --protocol tcp --port 443 --cidr 0.0.0.0/0

# ALB -> tasks. 3000 API, 9001 riders, 9002 drivers. NOT 1883: the plain-MQTT
# listener is for the backend over the private network and must never be public.
for p in 3000 9001 9002; do
  rule --group-id "$TASK_SG" --protocol tcp --port $p --source-group "$ALB_SG"
done

# Tasks -> each other, inside the group: api->valhalla/redis/mosquitto, and
# mosquitto->api for the auth callback.
for p in 3000 1883 6379 8002 9001 9002; do
  rule --group-id "$TASK_SG" --protocol tcp --port $p --source-group "$TASK_SG"
done

# Tasks -> EFS (NFS). Without this the broker task hangs at startup on mount.
rule --group-id "$EFS_SG" --protocol tcp --port 2049 --source-group "$TASK_SG"
echo "  ingress rules applied"

# ─── 4. EFS ──────────────────────────────────────────────────────────────────
say "EFS (mosquitto persistence)"
if [ -z "$MOSQ_UID" ] || [ -z "$MOSQ_GID" ]; then
  echo "  REFUSING: set MOSQ_UID and MOSQ_GID." >&2
  echo "  Find them with: docker run --rm --entrypoint id khmap-mqtt:test mosquitto" >&2
  echo "  The access point pins this user; a mismatch means the broker starts" >&2
  echo "  but silently cannot write persistence, losing state on every restart." >&2
  exit 1
fi
FS_ID=$(aws efs describe-file-systems \
  --query "FileSystems[?Name=='khmap-mosquitto'].FileSystemId | [0]" --output text)
if have "$FS_ID"; then
  echo "  filesystem $FS_ID exists"
else
  FS_ID=$(aws efs create-file-system --encrypted --performance-mode generalPurpose \
    --tags Key=Name,Value=khmap-mosquitto --query FileSystemId --output text)
  echo "  created $FS_ID — waiting for available"
  until [ "$(aws efs describe-file-systems --file-system-id "$FS_ID" \
      --query 'FileSystems[0].LifeCycleState' --output text)" = "available" ]; do sleep 3; done
fi

for s in $SUBNETS; do
  aws efs create-mount-target --file-system-id "$FS_ID" --subnet-id "$s" \
    --security-groups "$EFS_SG" >/dev/null 2>&1 \
    && echo "  mount target in $s" || echo "  mount target in $s already present"
done

AP_ID=$(aws efs describe-access-points --file-system-id "$FS_ID" \
  --query 'AccessPoints[0].AccessPointId' --output text 2>/dev/null || echo None)
if have "$AP_ID"; then
  echo "  access point $AP_ID exists"
else
  AP_ID=$(aws efs create-access-point --file-system-id "$FS_ID" \
    --posix-user "Uid=$MOSQ_UID,Gid=$MOSQ_GID" \
    --root-directory "Path=/mosquitto-data,CreationInfo={OwnerUid=$MOSQ_UID,OwnerGid=$MOSQ_GID,Permissions=755}" \
    --query AccessPointId --output text)
  echo "  access point $AP_ID created (uid=$MOSQ_UID gid=$MOSQ_GID)"
fi

# Scoped through the ACCESS POINT, not just the filesystem: the condition means
# this role can only ever mount /mosquitto-data as the pinned uid, never the
# filesystem root or another application's directory on the same filesystem.
aws iam put-role-policy --role-name khmapMosquittoTaskRole \
  --policy-name khmapEfsAccess \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"elasticfilesystem:ClientMount\",\"elasticfilesystem:ClientWrite\"],\"Resource\":\"arn:aws:elasticfilesystem:$AWS_REGION:$ACCOUNT:file-system/$FS_ID\",\"Condition\":{\"StringEquals\":{\"elasticfilesystem:AccessPointArn\":\"arn:aws:elasticfilesystem:$AWS_REGION:$ACCOUNT:access-point/$AP_ID\"}}}]}"
echo "  EFS access policy attached (scoped to $AP_ID)"

# ─── 5. ECS cluster + Service Connect namespace ──────────────────────────────
say "ECS cluster and $NAMESPACE namespace"
# Service Connect needs a Cloud Map namespace. ECS will usually create one
# implicitly, but not always — so create it explicitly and let any error show.
if aws servicediscovery list-namespaces \
     --query "Namespaces[?Name=='$NAMESPACE'].Id | [0]" --output text 2>/dev/null \
     | grep -qv '^None$'; then
  echo "  namespace $NAMESPACE exists"
else
  aws servicediscovery create-http-namespace --name "$NAMESPACE" >/dev/null
  echo "  namespace $NAMESPACE created"
fi

# NOTE: do not swallow stderr here. An earlier version did, and reported
# "cluster exists" when the create had actually failed — which only surfaced
# later as ClusterNotFoundException from CreateService, far from the cause.
CLUSTER_STATUS=$(aws ecs describe-clusters --clusters "$CLUSTER" \
  --query 'clusters[?status==`ACTIVE`].clusterName | [0]' --output text 2>/dev/null || echo None)
if have "$CLUSTER_STATUS"; then
  echo "  cluster $CLUSTER exists"
else
  aws ecs create-cluster --cluster-name "$CLUSTER" \
    --service-connect-defaults "namespace=$NAMESPACE" >/dev/null
  echo "  cluster $CLUSTER created"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
say "Values for deploy/taskdef-*.json"
cat <<SUMMARY
  <ACCOUNT_ID>           $ACCOUNT
  <REGION>               $AWS_REGION
  <EFS_ID>               $FS_ID
  <EFS_ACCESS_POINT_ID>  $AP_ID

  cluster                $CLUSTER
  namespace              $NAMESPACE
  vpc                    $VPC_ID
  subnets                $SUBNETS
  alb security group     $ALB_SG
  task security group    $TASK_SG

Fill the first two with:
  sed -i "s/<ACCOUNT_ID>/$ACCOUNT/g; s/<REGION>/$AWS_REGION/g" \\
    deploy/taskdef-*.json .github/workflows/deploy.yml

Still to fill by hand: <EFS_ID>, <EFS_ACCESS_POINT_ID>, <MQTT_DRIVER_DOMAIN>,
<CLOUDINARY_CLOUD_NAME>, <FIREBASE_PROJECT_ID>. Then: npx ts-node deploy/preflight.ts
SUMMARY
