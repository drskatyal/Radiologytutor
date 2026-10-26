# Optional. Prefer deploy/gcp/deploy-app.sh, which refuses to roll a revision
# until GEMINI_API_KEY, BETTER_AUTH_SECRET, and MONGODB_URI have versions.
# This resource assumes those versions already exist.

locals {
  dicomweb_env = {
    NODE_ENV               = "production"
    DICOMWEB_BACKEND       = "healthcare"
    HEALTHCARE_PROJECT     = var.project_id
    HEALTHCARE_LOCATION    = var.region
    HEALTHCARE_DATASET     = var.dataset_id
    HEALTHCARE_DICOM_STORE = var.dicom_store_id
    MONGODB_DB             = var.mongodb_db
    GEMINI_MODEL           = var.gemini_model
    GEMINI_TTS_MODEL       = "gemini-2.5-flash-preview-tts"
    GEMINI_TTS_VOICE       = "Kore"
    GEMINI_LIVE_MODEL      = "gemini-live-2.5-flash-native-audio"
    GEMINI_TIMEOUT_MS      = "45000"
    VOICE_LATENCY_BUDGET_MS = "1200"
    ELEVENLABS_TTS_MODEL   = "eleven_multilingual_v2"
    FRAME_CACHE_WAIT_MS    = "25"
    DEMO_AUTH_ENABLED      = "0"
  }
}

resource "google_cloud_run_v2_service" "app" {
  count    = var.deploy_app ? 1 : 0
  name     = var.service_name
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  lifecycle {
    precondition {
      condition     = var.app_image != ""
      error_message = "Set app_image when deploy_app is true."
    }
  }

  template {
    service_account                  = google_service_account.app.email
    timeout                          = "300s"
    max_instance_request_concurrency = 40
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"

    vpc_access {
      egress = var.vpc_egress
      network_interfaces {
        network    = google_compute_network.app.name
        subnetwork = google_compute_subnetwork.app.name
      }
    }

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      image = var.app_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "2"
          memory = "2Gi"
        }
        cpu_idle          = false
        startup_cpu_boost = true
      }

      dynamic "env" {
        for_each = local.dicomweb_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.public_url == "" ? [] : [var.public_url]
        content {
          name  = "BETTER_AUTH_URL"
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.frame_bucket == "" ? [] : [var.frame_bucket]
        content {
          name  = "R2_ENDPOINT"
          value = "https://storage.googleapis.com"
        }
      }

      dynamic "env" {
        for_each = var.frame_bucket == "" ? [] : [var.frame_bucket]
        content {
          name  = "R2_BUCKET"
          value = var.frame_bucket
        }
      }

      # Optional secrets (Google OAuth, ElevenLabs, GCS HMAC) are attached by
      # deploy/gcp/deploy-app.sh only when a version exists. Referencing an
      # empty secret here would stop the revision from starting.
      dynamic "env" {
        for_each = toset(["GEMINI_API_KEY", "BETTER_AUTH_SECRET", "MONGODB_URI"])
        content {
          name = env.value
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        initial_delay_seconds = 5
        timeout_seconds       = 3
        period_seconds        = 5
        failure_threshold     = 24
        http_get {
          path = "/"
          port = 8080
        }
      }
    }
  }

  depends_on = [google_project_service.apis, google_compute_router_nat.app]
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  count    = var.deploy_app ? 1 : 0
  name     = google_cloud_run_v2_service.app[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
