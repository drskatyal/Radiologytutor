# FlowRad Viewer on Google Cloud: viewer.flowrad.ai.
#
#   Cloud Run (Next.js standalone image)
#     ├─ Cloud Healthcare API DICOM store   stored, anonymised studies (DICOMweb)
#     ├─ Firestore (Native)                 accounts, studies, collections, shares
#     ├─ Identity Platform                  sign-in (Google, email link)
#     ├─ GCS: <downloads bucket>            desktop installers + downloads.json (public read)
#     └─ GCS: <frame bucket> (optional)     DICOMweb frame cache (private)
#
# Nothing here is applied by CI. A project owner runs `terraform apply` (see
# docs/VIEWER_SAAS.md). No secret values live in this repository.

locals {
  apis = [
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "healthcare.googleapis.com",
    "firestore.googleapis.com",
    "identitytoolkit.googleapis.com",
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
  ]
}

resource "google_project_service" "apis" {
  for_each           = toset(local.apis)
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "app" {
  location      = var.region
  repository_id = var.artifact_repo
  format        = "DOCKER"
  description   = "FlowRad Viewer images"
  depends_on    = [google_project_service.apis]
}

# ---------------------------------------------------------------------------
# Runtime identity: least privilege on exactly the resources the app touches.
# ---------------------------------------------------------------------------

resource "google_service_account" "app" {
  account_id   = var.service_account_id
  display_name = "FlowRad Viewer (Cloud Run)"
}

resource "google_healthcare_dataset" "viewer" {
  name       = var.dataset_id
  location   = var.region
  depends_on = [google_project_service.apis]
}

resource "google_healthcare_dicom_store" "studies" {
  name    = var.dicom_store_id
  dataset = google_healthcare_dataset.viewer.id
}

resource "google_healthcare_dicom_store_iam_member" "app_editor" {
  dicom_store_id = google_healthcare_dicom_store.studies.id
  role           = "roles/healthcare.dicomEditor"
  member         = "serviceAccount:${google_service_account.app.email}"
}

resource "google_firestore_database" "default" {
  name        = "(default)"
  location_id = var.firestore_location
  type        = "FIRESTORE_NATIVE"
  depends_on  = [google_project_service.apis]
}

resource "google_project_iam_member" "app_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.app.email}"
}

# Session signing key. Add a version after apply:
#   openssl rand -base64 48 | gcloud secrets versions add SESSION_SECRET --data-file=-
resource "google_secret_manager_secret" "session" {
  secret_id = "SESSION_SECRET"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "app_session" {
  secret_id = google_secret_manager_secret.session.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.app.email}"
}

# ---------------------------------------------------------------------------
# Desktop downloads: public-read objects, uploaded by the release workflow.
# ---------------------------------------------------------------------------

resource "google_storage_bucket" "downloads" {
  name                        = var.downloads_bucket
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "inherited"
  versioning {
    enabled = true
  }
  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "downloads_public" {
  bucket = google_storage_bucket.downloads.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

# Optional private frame cache for /api/dicomweb (lib/frameCache.ts, S3-compatible
# HMAC access). Empty name = no bucket; Healthcare stays the pixel source.
resource "google_storage_bucket" "frames" {
  count                       = var.frame_bucket == "" ? 0 : 1
  name                        = var.frame_bucket
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  lifecycle_rule {
    condition {
      age = 30
    }
    action {
      type = "Delete"
    }
  }
}

resource "google_storage_bucket_iam_member" "frames_app" {
  count  = var.frame_bucket == "" ? 0 : 1
  bucket = google_storage_bucket.frames[0].name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.app.email}"
}
