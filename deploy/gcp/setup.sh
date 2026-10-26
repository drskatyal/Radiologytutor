#!/usr/bin/env bash
# Create the GCP resources RadLearn needs before the first Cloud Run deploy.
# Idempotent. Does not print secret values. Does not create secret versions.
# Does not create the Atlas cluster (that account is outside this project).
#
#   set -a && source deploy/gcp/env.local && set +a
#   deploy/gcp/setup.sh
#
# See docs/GCP_CLOUD_RUN.md. Project id is radlearn-app, region europe-west2.
set -euo pipefail

PROJECT_ID=${PROJECT_ID:-radlearn-app}
REGION=${REGION:-europe-west2}
DATASET=${DATASET:-radlearn}
STORE=${STORE:-radlearn-dicom}
REPO=${REPO:-radlearn}
SA_NAME=${SA_NAME:-radlearn-app}
FRAME_BUCKET=${FRAME_BUCKET:-}
NETWORK=${NETWORK:-radlearn}
SUBNET=${SUBNET:-radlearn-run}
SUBNET_RANGE=${SUBNET_RANGE:-10.8.0.0/24}
ROUTER=${ROUTER:-radlearn-router}
NAT=${NAT:-radlearn-nat}
EGRESS_IP_NAME=${EGRESS_IP_NAME:-radlearn-egress}
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "Project:  ${PROJECT_ID}  (RadLearn)"
echo "Region:   ${REGION}  (app, DICOM store, NAT, and frame bucket must match)"
echo "Dataset:  ${DATASET}"
echo "Store:    ${STORE}"
echo "SA:       ${SA_EMAIL}"
echo "Network:  ${NETWORK} / ${SUBNET}"

gcloud config set project "${PROJECT_ID}" >/dev/null

gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  healthcare.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  iam.googleapis.com \
  compute.googleapis.com

if ! gcloud artifacts repositories describe "${REPO}" --location="${REGION}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${REPO}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="RadLearn images"
fi

if ! gcloud iam service-accounts describe "${SA_EMAIL}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SA_NAME}" \
    --display-name="RadLearn Cloud Run"
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

# Direct VPC egress so Cloud Run has a stable address for Atlas.
# Private Google Access keeps *.googleapis.com (Healthcare, Gemini) on Google's network.
if ! gcloud compute networks describe "${NETWORK}" >/dev/null 2>&1; then
  gcloud compute networks create "${NETWORK}" --subnet-mode=custom
fi

if ! gcloud compute networks subnets describe "${SUBNET}" --region="${REGION}" >/dev/null 2>&1; then
  gcloud compute networks subnets create "${SUBNET}" \
    --network="${NETWORK}" \
    --region="${REGION}" \
    --range="${SUBNET_RANGE}" \
    --enable-private-ip-google-access
else
  gcloud compute networks subnets update "${SUBNET}" \
    --region="${REGION}" \
    --enable-private-ip-google-access
fi

PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')
RUN_ROBOT="service-${PROJECT_NUMBER}@serverless-robot-prod.iam.gserviceaccount.com"
gcloud compute networks subnets add-iam-policy-binding "${SUBNET}" \
  --region="${REGION}" \
  --member="serviceAccount:${RUN_ROBOT}" \
  --role="roles/compute.networkUser" \
  >/dev/null

if ! gcloud compute addresses describe "${EGRESS_IP_NAME}" --region="${REGION}" >/dev/null 2>&1; then
  gcloud compute addresses create "${EGRESS_IP_NAME}" --region="${REGION}"
fi

if ! gcloud compute routers describe "${ROUTER}" --region="${REGION}" >/dev/null 2>&1; then
  gcloud compute routers create "${ROUTER}" \
    --network="${NETWORK}" \
    --region="${REGION}"
fi

if ! gcloud compute routers nats describe "${NAT}" --router="${ROUTER}" --region="${REGION}" >/dev/null 2>&1; then
  gcloud compute routers nats create "${NAT}" \
    --router="${ROUTER}" \
    --region="${REGION}" \
    --nat-external-ip-pool="${EGRESS_IP_NAME}" \
    --nat-custom-subnet-ip-ranges="${SUBNET}"
fi

EGRESS_IP=$(gcloud compute addresses describe "${EGRESS_IP_NAME}" --region="${REGION}" --format='value(address)')

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

Atlas (MongoDB, GCP region EUROPE_WEST_2 / London). JSON-on-disk is refused on Cloud Run.
  Allow only this egress IP on the cluster (not 0.0.0.0/0): ${EGRESS_IP}
  Put the SRV URI in secret MONGODB_URI. Set the database name to radlearn (MONGODB_DB).
  Preferred later: Atlas Private Service Connect into ${NETWORK}/${SUBNET}, then
  VPC_EGRESS=private-ranges-only so DICOM skips the NAT. See docs/GCP_CLOUD_RUN.md.

Next: add secret versions, then deploy/gcp/deploy-app.sh.
  printf '%s' "\$GEMINI_API_KEY" | gcloud secrets versions add GEMINI_API_KEY --data-file=-
  printf '%s' "\$BETTER_AUTH_SECRET" | gcloud secrets versions add BETTER_AUTH_SECRET --data-file=-
  printf '%s' "\$MONGODB_URI" | gcloud secrets versions add MONGODB_URI --data-file=-

Optional, same pattern: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ELEVENLABS_API_KEY,
R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (GCS HMAC of ${SA_EMAIL} if you set FRAME_BUCKET).

EOF
