#!/usr/bin/env bash
# Create the GCP resources FlowRad Learn needs before the first Cloud Run deploy.
# Idempotent. Does not print secret values. Does not create secret versions.
#
#   set -a && source deploy/gcp/env.local && set +a
#   deploy/gcp/setup.sh
#
# See docs/GCP_CLOUD_RUN.md for the checklist and the placeholders.
set -euo pipefail

PROJECT_ID=${PROJECT_ID:?Set PROJECT_ID (see deploy/gcp/env.example)}
REGION=${REGION:-us-east4}
DATASET=${DATASET:-flowrad}
STORE=${STORE:-flowrad-dicom}
REPO=${REPO:-flowrad}
SA_NAME=${SA_NAME:-flowrad-app}
FRAME_BUCKET=${FRAME_BUCKET:-}
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "Project:  ${PROJECT_ID}"
echo "Region:   ${REGION}  (app, DICOM store, and frame bucket must match)"
echo "Dataset:  ${DATASET}"
echo "Store:    ${STORE}"
echo "SA:       ${SA_EMAIL}"

gcloud config set project "${PROJECT_ID}" >/dev/null

gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  healthcare.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  iam.googleapis.com

if ! gcloud artifacts repositories describe "${REPO}" --location="${REGION}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${REPO}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="FlowRad Learn images"
fi

if ! gcloud iam service-accounts describe "${SA_EMAIL}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SA_NAME}" \
    --display-name="FlowRad Learn Cloud Run"
fi

if ! gcloud healthcare datasets describe "${DATASET}" --location="${REGION}" >/dev/null 2>&1; then
  gcloud healthcare datasets create "${DATASET}" --location="${REGION}"
fi

if ! gcloud healthcare dicom-stores describe "${STORE}" \
  --dataset="${DATASET}" --location="${REGION}" >/dev/null 2>&1; then
  gcloud healthcare dicom-stores create "${STORE}" \
    --dataset="${DATASET}" --location="${REGION}"
fi

# Store-level editor: WADO-RS read + STOW-RS write. Not dataset admin, not allUsers.
gcloud healthcare dicom-stores add-iam-policy-binding "${STORE}" \
  --dataset="${DATASET}" \
  --location="${REGION}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/healthcare.dicomEditor" \
  >/dev/null

if [[ -n "${FRAME_BUCKET}" ]]; then
  if ! gcloud storage buckets describe "gs://${FRAME_BUCKET}" >/dev/null 2>&1; then
    gcloud storage buckets create "gs://${FRAME_BUCKET}" \
      --location="${REGION}" \
      --uniform-bucket-level-access \
      --public-access-prevention
  fi
  gcloud storage buckets add-iam-policy-binding "gs://${FRAME_BUCKET}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/storage.objectAdmin" \
    >/dev/null
fi

# Secret containers only. Add versions yourself — never commit the values.
REQUIRED_SECRETS=(GEMINI_API_KEY BETTER_AUTH_SECRET MONGODB_URI)
OPTIONAL_SECRETS=(GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET ELEVENLABS_API_KEY R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY)
for name in "${REQUIRED_SECRETS[@]}" "${OPTIONAL_SECRETS[@]}"; do
  if ! gcloud secrets describe "${name}" >/dev/null 2>&1; then
    gcloud secrets create "${name}" --replication-policy=automatic
  fi
  gcloud secrets add-iam-policy-binding "${name}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" \
    >/dev/null
done

cat <<EOF

Imaging root (server-side only — the browser never calls this):
  https://healthcare.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/datasets/${DATASET}/dicomStores/${STORE}/dicomWeb

Next: add secret versions, then deploy/gcp/deploy-app.sh.
  printf '%s' "\$GEMINI_API_KEY" | gcloud secrets versions add GEMINI_API_KEY --data-file=-
  printf '%s' "\$BETTER_AUTH_SECRET" | gcloud secrets versions add BETTER_AUTH_SECRET --data-file=-
  printf '%s' "\$MONGODB_URI" | gcloud secrets versions add MONGODB_URI --data-file=-

Optional, same pattern: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ELEVENLABS_API_KEY,
R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (GCS HMAC of ${SA_EMAIL} if you set FRAME_BUCKET).

EOF
