# Converted-DICOM delivery (lib/dicomCdn, docs/DICOM_CDN_REPORT.md).
#
#   private bucket   HTJ2K frames + 8-bit previews + metadata, written once per
#                    series by the app (after upload) or the backfill script.
#                    Uniform access, public access prevention ENFORCED. No
#                    allUsers binding anywhere.
#   Cloud CDN        backend bucket behind a global HTTPS load balancer on its
#                    own hostname. Every request must carry a Cloud CDN signed
#                    URL-prefix (minted per series by /api/dicom-cdn/manifest
#                    after the session + org check). FORCE_CACHE_ALL: objects
#                    say `Cache-Control: private` so no other shared cache may
#                    keep them, but the CDN edge does — and it still checks the
#                    signature on every hit.
#
# Off by default. Set dicom_cdn_bucket to create the bucket (the app then
# serves chunks itself through /api/dicom-cdn/files). Also set
# dicom_cdn_domain + dicom_cdn_signing_key to put Cloud CDN in front.
# Apply is a deliberate operator step — nothing here runs on deploy.

locals {
  dicom_cdn_bucket_on = var.dicom_cdn_bucket != ""
  dicom_cdn_edge_on   = local.dicom_cdn_bucket_on && var.dicom_cdn_domain != "" && var.dicom_cdn_signing_key != ""
}

resource "google_storage_bucket" "dicom_cdn" {
  count                       = local.dicom_cdn_bucket_on ? 1 : 0
  name                        = var.dicom_cdn_bucket
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  # The browser reads chunks cross-origin from the CDN hostname. GET only;
  # Range lets the viewer pull the slice on screen out of its chunk first.
  cors {
    origin          = var.public_url == "" ? [] : [var.public_url]
    method          = ["GET", "HEAD"]
    response_header = ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Range"]
    max_age_seconds = 3600
  }
}

# The app writes bundles and reads index.json. Bucket-scoped, not project-wide.
resource "google_storage_bucket_iam_member" "dicom_cdn_app" {
  count  = local.dicom_cdn_bucket_on ? 1 : 0
  bucket = google_storage_bucket.dicom_cdn[0].name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${local.app_sa}"
}

# Cloud CDN fills its cache from the private bucket as its own service agent.
resource "google_storage_bucket_iam_member" "dicom_cdn_fill" {
  count  = local.dicom_cdn_edge_on ? 1 : 0
  bucket = google_storage_bucket.dicom_cdn[0].name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:service-${data.google_project.current.number}@cloud-cdn-fill.iam.gserviceaccount.com"
}

resource "google_compute_backend_bucket" "dicom_cdn" {
  count       = local.dicom_cdn_edge_on ? 1 : 0
  name        = "radlearn-dicom-cdn"
  bucket_name = google_storage_bucket.dicom_cdn[0].name
  enable_cdn  = true

  cdn_policy {
    cache_mode                   = "FORCE_CACHE_ALL"
    default_ttl                  = 86400
    max_ttl                      = 31536000
    client_ttl                   = 86400
    signed_url_cache_max_age_sec = 3600
    request_coalescing           = true
    negative_caching             = false
  }
}

# The signing key the app holds as DICOM_CDN_KEY (Secret Manager). Generate:
#   head -c 16 /dev/urandom | base64 | tr +/ -_
# It also lands in Terraform state: keep state in a private bucket.
resource "google_compute_backend_bucket_signed_url_key" "dicom_cdn" {
  count          = local.dicom_cdn_edge_on ? 1 : 0
  name           = var.dicom_cdn_key_name
  key_value      = var.dicom_cdn_signing_key
  backend_bucket = google_compute_backend_bucket.dicom_cdn[0].name
}

resource "google_compute_url_map" "dicom_cdn" {
  count           = local.dicom_cdn_edge_on ? 1 : 0
  name            = "radlearn-dicom-cdn"
  default_service = google_compute_backend_bucket.dicom_cdn[0].id
}

resource "google_compute_managed_ssl_certificate" "dicom_cdn" {
  count = local.dicom_cdn_edge_on ? 1 : 0
  name  = "radlearn-dicom-cdn"
  managed {
    domains = [var.dicom_cdn_domain]
  }
}

resource "google_compute_target_https_proxy" "dicom_cdn" {
  count            = local.dicom_cdn_edge_on ? 1 : 0
  name             = "radlearn-dicom-cdn"
  url_map          = google_compute_url_map.dicom_cdn[0].id
  ssl_certificates = [google_compute_managed_ssl_certificate.dicom_cdn[0].id]
}

resource "google_compute_global_address" "dicom_cdn" {
  count = local.dicom_cdn_edge_on ? 1 : 0
  name  = "radlearn-dicom-cdn"
}

resource "google_compute_global_forwarding_rule" "dicom_cdn" {
  count                 = local.dicom_cdn_edge_on ? 1 : 0
  name                  = "radlearn-dicom-cdn"
  target                = google_compute_target_https_proxy.dicom_cdn[0].id
  ip_address            = google_compute_global_address.dicom_cdn[0].address
  port_range            = "443"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

output "dicom_cdn_bucket" {
  value = local.dicom_cdn_bucket_on ? google_storage_bucket.dicom_cdn[0].name : null
}

output "dicom_cdn_ip" {
  description = "Point an A record for dicom_cdn_domain here. The managed certificate provisions once DNS resolves."
  value       = local.dicom_cdn_edge_on ? google_compute_global_address.dicom_cdn[0].address : null
}

output "dicom_cdn_url" {
  description = "DICOM_CDN_URL for the app."
  value       = local.dicom_cdn_edge_on ? "https://${var.dicom_cdn_domain}" : null
}
