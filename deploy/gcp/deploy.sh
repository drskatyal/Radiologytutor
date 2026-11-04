#!/usr/bin/env bash
# Build the image with Cloud Build and roll it out to Cloud Run.
# Run by a person with access to the project, after `terraform apply`.
# Never run from CI on a pull request.
#
#   PROJECT_ID=flowrad-viewer-prod REGION=europe-west2 deploy/gcp/deploy.sh
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-europe-west2}"
SERVICE="${SERVICE:-flowrad-viewer}"
REPO="${REPO:-flowrad-viewer}"
SHA="$(git rev-parse --short HEAD)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/viewer:${SHA}"

if [ -n "$(git status --porcelain)" ]; then
  echo "Refusing to deploy a dirty working tree." >&2
  exit 1
fi

gcloud builds submit --project "$PROJECT_ID" --region "$REGION" \
  --tag "$IMAGE" .

gcloud run deploy "$SERVICE" --project "$PROJECT_ID" --region "$REGION" \
  --image "$IMAGE" --quiet

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
echo "Deployed ${IMAGE} -> ${URL}"
curl -fsS -o /dev/null -w "GET / -> %{http_code}\n" "$URL/"
curl -fsS -o /dev/null -w "GET /viewer -> %{http_code}\n" "$URL/viewer"
