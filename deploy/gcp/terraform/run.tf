# Cloud Run service + optional custom domain + GitHub release uploader.

resource "google_cloud_run_v2_service" "viewer" {
  name     = var.service_name
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.app.email
    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }
    containers {
      # deploy/gcp/deploy.sh builds and rolls out new images; this is the first one.
      image = var.image
      resources {
        limits = { cpu = "2", memory = "2Gi" }
      }
      env {
        name  = "DICOMWEB_BACKEND"
        value = "healthcare"
      }
      env {
        name  = "HEALTHCARE_PROJECT"
        value = var.project_id
      }
      env {
        name  = "HEALTHCARE_LOCATION"
        value = var.region
      }
      env {
        name  = "HEALTHCARE_DATASET"
        value = google_healthcare_dataset.viewer.name
      }
      env {
        name  = "HEALTHCARE_DICOM_STORE"
        value = google_healthcare_dicom_store.studies.name
      }
      env {
        name  = "FIRESTORE_PROJECT"
        value = var.project_id
      }
      env {
        name  = "IDENTITY_PROJECT_ID"
        value = var.project_id
      }
      env {
        # Public by design (Firebase web config); the server verifies every ID token.
        name  = "IDENTITY_API_KEY"
        value = var.identity_api_key
      }
      env {
        name  = "IDENTITY_AUTH_DOMAIN"
        value = var.identity_auth_domain
      }
      env {
        name  = "PUBLIC_ORIGIN"
        value = var.public_origin
      }
      env {
        name  = "DOWNLOADS_MANIFEST_URL"
        value = "https://storage.googleapis.com/${google_storage_bucket.downloads.name}/desktop/downloads.json"
      }
      env {
        name = "SESSION_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.session.secret_id
            version = "latest"
          }
        }
      }
    }
  }

  lifecycle {
    # deploy.sh owns the image tag after the first apply.
    ignore_changes = [template[0].containers[0].image]
  }
  depends_on = [google_project_service.apis, google_secret_manager_secret_iam_member.app_session]
}

# The site is public: anyone may load the viewer, share links and embeds.
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.viewer.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# viewer.flowrad.ai → this service. Needs the domain verified in the project
# (Search Console) and a DNS record at the registrar; see outputs.
resource "google_cloud_run_domain_mapping" "viewer" {
  count    = var.custom_domain == "" ? 0 : 1
  name     = var.custom_domain
  location = var.region
  metadata {
    namespace = var.project_id
  }
  spec {
    route_name = google_cloud_run_v2_service.viewer.name
  }
}

# ---------------------------------------------------------------------------
# GitHub Actions (desktop-release.yml) uploads installers with Workload
# Identity Federation: no long-lived key. Only the named repository can use it.
# ---------------------------------------------------------------------------

resource "google_service_account" "release" {
  account_id   = "flowrad-viewer-release"
  display_name = "FlowRad Viewer release uploader (GitHub Actions)"
}

resource "google_storage_bucket_iam_member" "release_downloads" {
  bucket = google_storage_bucket.downloads.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.release.email}"
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }
  attribute_condition = "assertion.repository == '${var.github_repository}'"
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "release_wif" {
  service_account_id = google_service_account.release.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}
