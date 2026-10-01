#!/usr/bin/env bash
#
# Lets GitHub Actions deploy without storing AWS keys anywhere.
#
#   ./deploy/setup-github-oidc.sh
#
# GitHub mints a short-lived OIDC token for each workflow run; AWS trusts that
# token and issues temporary credentials. Nothing long-lived exists to leak,
# and revoking access is deleting one role.
#
# Safe to re-run.
set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-southeast-1}"
REPO="${REPO:-Sokleap-SAM/KH-Map-Backend}"
# Only this branch may assume the role. Without this the condition would be
# satisfied by ANY branch — including one opened by a pull request — which
# would hand AWS credentials to anyone who can push a branch.
BRANCH="${BRANCH:-production}"
ROLE="${ROLE:-khmapGithubActionsRole}"
SECRET_NAME="${SECRET_NAME:-khmap/prod}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
PROVIDER="arn:aws:iam::$ACCOUNT:oidc-provider/token.actions.githubusercontent.com"

say "OIDC provider"
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER" >/dev/null 2>&1; then
  echo "  exists"
else
  aws iam create-open-id-connect-provider \
    --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com >/dev/null
  echo "  created"
fi

say "Role $ROLE"
TRUST=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "$PROVIDER" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": "repo:$REPO:ref:refs/heads/$BRANCH" }
    }
  }]
}
JSON
)
if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$ROLE" --policy-document "$TRUST"
  echo "  trust policy updated (repo:$REPO, branch:$BRANCH)"
else
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document "$TRUST" >/dev/null
  echo "  created (repo:$REPO, branch:$BRANCH)"
fi

# Deliberately narrower than your admin user: push images, roll services, read
# nothing else. iam:PassRole is required because registering a task definition
# hands the execution and task roles to ECS — and it is scoped to exactly those
# roles, so this role cannot pass an arbitrary one to a task it controls.
say "Permissions"
aws iam put-role-policy --role-name "$ROLE" --policy-name khmapDeploy --policy-document "$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*" },
    { "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage",
        "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"
      ],
      "Resource": [
        "arn:aws:ecr:$AWS_REGION:$ACCOUNT:repository/khmap-api",
        "arn:aws:ecr:$AWS_REGION:$ACCOUNT:repository/khmap-mosquitto",
        "arn:aws:ecr:$AWS_REGION:$ACCOUNT:repository/khmap-valhalla"
      ] },
    { "Effect": "Allow",
      "Action": ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition"],
      "Resource": "*" },
    { "Effect": "Allow",
      "Action": ["ecs:UpdateService", "ecs:DescribeServices"],
      "Resource": "arn:aws:ecs:$AWS_REGION:$ACCOUNT:service/khmap/*" },
    { "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "arn:aws:iam::$ACCOUNT:role/khmapEcsTaskExecutionRole",
        "arn:aws:iam::$ACCOUNT:role/khmapApiTaskRole",
        "arn:aws:iam::$ACCOUNT:role/khmapMosquittoTaskRole"
      ] }
  ]
}
JSON
)"
echo "  khmapDeploy attached (ECR push + ECS update + scoped PassRole)"

FS_ID=$(aws efs describe-file-systems --query "FileSystems[?Name=='khmap-mosquitto'].FileSystemId | [0]" --output text 2>/dev/null)
AP_ID=$(aws efs describe-access-points --file-system-id "$FS_ID" --query 'AccessPoints[0].AccessPointId' --output text 2>/dev/null)

say "Now set these in GitHub"
cat <<SUMMARY
  Settings -> Secrets and variables -> Actions -> New repository secret

    AWS_ACCOUNT_ID         $ACCOUNT
    EFS_ID                 $FS_ID
    EFS_ACCESS_POINT_ID    $AP_ID

  And in .github/workflows/deploy.yml replace:
    AWS_REGION: <REGION>        ->  $AWS_REGION
    ECR_REGISTRY: ...           ->  $ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com
    role-to-assume: ...         ->  arn:aws:iam::$ACCOUNT:role/$ROLE

  None of those are credentials, so they can live in the workflow file — but
  the account id is in a public repo, so secrets are the tidier choice.

  Then: merge into $BRANCH and the deploy runs itself.
SUMMARY
