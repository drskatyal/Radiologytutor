output "dicomweb_root" {
  description = "Server-side DICOMweb root. Do not expose this URL to the browser."
  value       = "https://healthcare.googleapis.com/v1/${google_healthcare_dicom_store.flowrad.id}/dicomWeb"
}

output "runtime_service_account" {
  value = google_service_account.app.email
}

output "artifact_registry" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${var.artifact_repo}/app"
}

output "frame_bucket" {
  value = var.frame_bucket == "" ? null : google_storage_bucket.frames[0].name
}
