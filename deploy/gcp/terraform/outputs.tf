output "service_url" {
  value = google_cloud_run_v2_service.viewer.uri
}

output "dicomweb_root" {
  value = "https://healthcare.googleapis.com/v1/${google_healthcare_dicom_store.studies.id}/dicomWeb"
}

output "downloads_manifest_url" {
  value = "https://storage.googleapis.com/${google_storage_bucket.downloads.name}/desktop/downloads.json"
}

output "release_service_account" {
  description = "Set as the GCP_RELEASE_SERVICE_ACCOUNT repository variable."
  value       = google_service_account.release.email
}

output "workload_identity_provider" {
  description = "Set as the GCP_WORKLOAD_IDENTITY_PROVIDER repository variable."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "domain_dns_records" {
  description = "DNS records to create at the registrar for the custom domain."
  value       = try(google_cloud_run_domain_mapping.viewer[0].status[0].resource_records, [])
}
