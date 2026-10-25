locals {
  apis = [
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "healthcare.googleapis.com",
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
    "iam.googleapis.com",
  ]
  secret_ids = [
    "GEMINI_API_KEY",
    "BETTER_AUTH_SECRET",
    "MONGODB_URI",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "ELEVENLABS_API_KEY",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
  ]
  app_sa = google_service_account.app.email
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
  description   = "FlowRad Learn images"
  depends_on    = [google_project_service.apis]
}

resource "google_service_account" "app" {
  account_id   = var.service_account_id
  display_name = "FlowRad Learn Cloud Run"
}

resource "google_healthcare_dataset" "flowrad" {
  name       = var.dataset_id
  location   = var.region
  depends_on = [google_project_service.apis]
}

resource "google_healthcare_dicom_store" "flowrad" {
  name    = var.dicom_store_id
  dataset = google_healthcare_dataset.flowrad.id
}

# dicomWebRead + dicomWebWrite. Not dataset admin. Not allUsers.
resource "google_healthcare_dicom_store_iam_member" "app_editor" {
  dicom_store_id = google_healthcare_dicom_store.flowrad.id
  role           = "roles/healthcare.dicomEditor"
  member         = "serviceAccount:${local.app_sa}"
}

resource "google_storage_bucket" "frames" {
  count                       = var.frame_bucket == "" ? 0 : 1
  name                        = var.frame_bucket
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
}

resource "google_storage_bucket_iam_member" "frames_app" {
  count  = var.frame_bucket == "" ? 0 : 1
  bucket = google_storage_bucket.frames[0].name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${local.app_sa}"
}

resource "google_secret_manager_secret" "app" {
  for_each  = toset(local.secret_ids)
  secret_id = each.value
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "app" {
  for_each  = google_secret_manager_secret.app
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.app_sa}"
}
