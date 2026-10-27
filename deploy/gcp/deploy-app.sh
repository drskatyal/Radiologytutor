#!/usr/bin/env bash
# Build (unless SKIP_BUILD=1) and deploy the Next.js app to Cloud Run.
# The DICOM store, VPC, and Cloud NAT must already exist (deploy/gcp/setup.sh).
# Required secret versions: GEMINI_API_KEY, BETTER_AUTH_SECRET, MONGODB_URI.
# Cloud Run refuses to boot the JSON store: MONGODB_URI is mandatory.
#
# Env policy — do not hardcode a downgrade:
#   Exported shell variables override the live service.
#   Unset variables keep the value already on the service.
#   Only a missing service value falls through to the defaults below.
#   DEMO_AUTH_ENABLED=1
#   DEMO_AUTH_MAX_ROLE=author
#   GEMINI_MODEL=gemini-3.8-flash
#   GEMINI_LIVE_MODEL=gemini-3.8-live
#   gemini-live-2.5-flash-native-audio is refused unless
#   ALLOW_STALE_GEMINI_LIVE_MODEL=1.
#   Flags are --update-env-vars, so a console-set variable this script does
#   not mention is left alone. See docs/GCP_CLOUD_RUN.md.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=resolve-deploy-env.sh
source "$(dirname "$0")/resolve-deploy-env.sh"
PROJECT_ID=${PROJECT_ID:-radlearn-app}
REGION=${REGION:-europe-west2}
SERVICE=${SERVICE:-radlearn}
DATASET=${DATASET:-radlearn}
STORE=${STORE:-radlearn-dicom}
REPO=${REPO:-radlearn}
SA_NAME=${SA_NAME:-radlearn-app}
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
FRAME_BUCKET=${FRAME_BUCKET:-}
NETWORK=${NETWORK:-radlearn}
SUBNET=${SUBNET:-radlearn-run}
VPC_EGRESS=${VPC_EGRESS:-all-traffic}
MIN_INSTANCES=${MIN_INSTANCES:-1}
MAX_INSTANCES=${MAX_INSTANCES:-10}
MONGODB_DB=${MONGODB_DB:-radlearn}
IMAGE=${IMAGE:-"${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/app:latest"}

for name in GEMINI_API_KEY BETTER_AUTH_SECRET MONGODB_URI; do
  if ! gcloud secrets versions describe latest --secret="${name}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    echo "Missing secret version: ${name}. Add it before deploy (docs/GCP_CLOUD_RUN.md)." >&2
    exit 1
  fi
done

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
  docker build -t "${IMAGE}" "${ROOT}"
  docker push "${IMAGE}"
fi

declare -A EXISTING=()
if SERVICE_JSON=$(gcloud run services describe "${SERVICE}" \
  --project="${PROJECT_ID}" --region="${REGION}" --format=json 2>/dev/null); then
  while IFS=$'\t' read -r key value; do
    [[ -n "$key" ]] && EXISTING["$key"]="$value"
  done < <(printf '%s' "${SERVICE_JSON}" | cloud_run_env_tsv)
fi

env_get() {
  local key="$1"
  local default="$2"
  local existing="${EXISTING[$key]-}"
  local value
  value="$(resolve_deploy_env "$key" "$default" "$existing")"
  if [[ "$key" == "GEMINI_LIVE_MODEL" ]]; then
    value="$(guard_gemini_live_model "$value" "$existing")"
  fi
  printf '%s' "$value"
}

ENV_VARS="NODE_ENV=production"
ENV_VARS+=",DICOMWEB_BACKEND=$(env_get DICOMWEB_BACKEND healthcare)"
ENV_VARS+=",HEALTHCARE_PROJECT=$(env_get HEALTHCARE_PROJECT "${PROJECT_ID}")"
ENV_VARS+=",HEALTHCARE_LOCATION=$(env_get HEALTHCARE_LOCATION "${REGION}")"
ENV_VARS+=",HEALTHCARE_DATASET=$(env_get HEALTHCARE_DATASET "${DATASET}")"
ENV_VARS+=",HEALTHCARE_DICOM_STORE=$(env_get HEALTHCARE_DICOM_STORE "${STORE}")"
ENV_VARS+=",MONGODB_DB=$(env_get MONGODB_DB "${MONGODB_DB}")"
ENV_VARS+=",GEMINI_MODEL=$(env_get GEMINI_MODEL gemini-3.8-flash)"
ENV_VARS+=",GEMINI_TTS_MODEL=$(env_get GEMINI_TTS_MODEL gemini-2.5-flash-preview-tts)"
ENV_VARS+=",GEMINI_TTS_VOICE=$(env_get GEMINI_TTS_VOICE Kore)"
ENV_VARS+=",GEMINI_LIVE_MODEL=$(env_get GEMINI_LIVE_MODEL gemini-3.8-live)"
ENV_VARS+=",GEMINI_TIMEOUT_MS=$(env_get GEMINI_TIMEOUT_MS 45000)"
ENV_VARS+=",VOICE_LATENCY_BUDGET_MS=$(env_get VOICE_LATENCY_BUDGET_MS 1200)"
ENV_VARS+=",ELEVENLABS_TTS_MODEL=$(env_get ELEVENLABS_TTS_MODEL eleven_multilingual_v2)"
ENV_VARS+=",FRAME_CACHE_WAIT_MS=$(env_get FRAME_CACHE_WAIT_MS 25)"
ENV_VARS+=",DEMO_AUTH_ENABLED=$(env_get DEMO_AUTH_ENABLED 1)"
ENV_VARS+=",DEMO_AUTH_MAX_ROLE=$(env_get DEMO_AUTH_MAX_ROLE author)"
if [[ -n "${BETTER_AUTH_URL:-}" ]]; then
  ENV_VARS+=",BETTER_AUTH_URL=${BETTER_AUTH_URL}"
fi
if [[ -n "${FRAME_BUCKET}" ]]; then
  ENV_VARS+=",R2_ENDPOINT=https://storage.googleapis.com"
  ENV_VARS+=",R2_BUCKET=${FRAME_BUCKET}"
fi

SECRETS="GEMINI_API_KEY=GEMINI_API_KEY:latest"
SECRETS+=",BETTER_AUTH_SECRET=BETTER_AUTH_SECRET:latest"
SECRETS+=",MONGODB_URI=MONGODB_URI:latest"
for name in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET ELEVENLABS_API_KEY R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  if gcloud secrets versions describe latest --secret="${name}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    SECRETS+=",${name}=${name}:latest"
  fi
done

gcloud run deploy "${SERVICE}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --image="${IMAGE}" \
  --service-account="${SA_EMAIL}" \
  --port=8080 \
  --cpu=2 \
  --memory=2Gi \
  --min-instances="${MIN_INSTANCES}" \
  --max-instances="${MAX_INSTANCES}" \
  --concurrency=40 \
  --timeout=300 \
  --cpu-boost \
  --no-cpu-throttling \
  --execution-environment=gen2 \
  --network="${NETWORK}" \
  --subnet="${SUBNET}" \
  --vpc-egress="${VPC_EGRESS}" \
  --ingress=all \
  --allow-unauthenticated \
  --labels=app=radlearn,role=web \
  --startup-probe="initialDelaySeconds=5,timeoutSeconds=3,periodSeconds=5,failureThreshold=24,httpGet.port=8080,httpGet.path=/" \
  --update-env-vars="${ENV_VARS}" \
  --set-secrets="${SECRETS}"

URL=$(gcloud run services describe "${SERVICE}" \
  --project="${PROJECT_ID}" --region="${REGION}" \
  --format='value(status.url)')

# First boot only. An existing BETTER_AUTH_URL (custom domain or a previous
# deploy) is left alone — filling it from status.url would rewrite it.
if [[ -z "${BETTER_AUTH_URL:-}" && -z "${EXISTING[BETTER_AUTH_URL]-}" && -n "${URL}" ]]; then
  gcloud run services update "${SERVICE}" \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --update-env-vars="BETTER_AUTH_URL=${URL}"
fi

echo
echo "App: ${URL:-"(url pending)"}"
echo "Set the Google OAuth redirect to \${BETTER_AUTH_URL}/api/auth/callback/google"
echo "DICOM: browser → ${URL}/api/dicomweb → Healthcare store ${STORE} in ${REGION}"
