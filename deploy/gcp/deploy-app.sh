#!/usr/bin/env bash
# Build (unless SKIP_BUILD=1) and deploy the Next.js app to Cloud Run.
# The DICOM store must already exist (deploy/gcp/setup.sh).
# Required secret versions: GEMINI_API_KEY, BETTER_AUTH_SECRET, MONGODB_URI.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PROJECT_ID=${PROJECT_ID:?Set PROJECT_ID (see deploy/gcp/env.example)}
REGION=${REGION:-us-east4}
SERVICE=${SERVICE:-flowrad-learn}
DATASET=${DATASET:-flowrad}
STORE=${STORE:-flowrad-dicom}
REPO=${REPO:-flowrad}
SA_NAME=${SA_NAME:-flowrad-app}
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
FRAME_BUCKET=${FRAME_BUCKET:-}
MIN_INSTANCES=${MIN_INSTANCES:-1}
MAX_INSTANCES=${MAX_INSTANCES:-10}
MONGODB_DB=${MONGODB_DB:-flowrad}
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

ENV_VARS="NODE_ENV=production"
ENV_VARS+=",DICOMWEB_BACKEND=healthcare"
ENV_VARS+=",HEALTHCARE_PROJECT=${PROJECT_ID}"
ENV_VARS+=",HEALTHCARE_LOCATION=${REGION}"
ENV_VARS+=",HEALTHCARE_DATASET=${DATASET}"
ENV_VARS+=",HEALTHCARE_DICOM_STORE=${STORE}"
ENV_VARS+=",MONGODB_DB=${MONGODB_DB}"
ENV_VARS+=",GEMINI_MODEL=${GEMINI_MODEL:-gemini-3.7-flash}"
ENV_VARS+=",GEMINI_TTS_MODEL=${GEMINI_TTS_MODEL:-gemini-2.5-flash-preview-tts}"
ENV_VARS+=",GEMINI_TTS_VOICE=${GEMINI_TTS_VOICE:-Kore}"
ENV_VARS+=",GEMINI_LIVE_MODEL=${GEMINI_LIVE_MODEL:-gemini-live-2.5-flash-native-audio}"
ENV_VARS+=",GEMINI_TIMEOUT_MS=${GEMINI_TIMEOUT_MS:-45000}"
ENV_VARS+=",VOICE_LATENCY_BUDGET_MS=${VOICE_LATENCY_BUDGET_MS:-1200}"
ENV_VARS+=",ELEVENLABS_TTS_MODEL=${ELEVENLABS_TTS_MODEL:-eleven_multilingual_v2}"
ENV_VARS+=",FRAME_CACHE_WAIT_MS=${FRAME_CACHE_WAIT_MS:-25}"
ENV_VARS+=",DEMO_AUTH_ENABLED=0"
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
  --ingress=all \
  --allow-unauthenticated \
  --labels=app=flowrad,role=web \
  --startup-probe="initialDelaySeconds=5,timeoutSeconds=3,periodSeconds=5,failureThreshold=24,httpGet.port=8080,httpGet.path=/" \
  --set-env-vars="${ENV_VARS}" \
  --set-secrets="${SECRETS}"

URL=$(gcloud run services describe "${SERVICE}" \
  --project="${PROJECT_ID}" --region="${REGION}" \
  --format='value(status.url)')

if [[ -z "${BETTER_AUTH_URL:-}" && -n "${URL}" ]]; then
  gcloud run services update "${SERVICE}" \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --update-env-vars="BETTER_AUTH_URL=${URL}"
fi

echo
echo "App: ${URL:-"(url pending)"}"
echo "Set the Google OAuth redirect to \${BETTER_AUTH_URL}/api/auth/callback/google"
echo "DICOM: browser → ${URL}/api/dicomweb → Healthcare store ${STORE} in ${REGION}"
