variable "project_id" {
  description = "GCP project id for viewer.flowrad.ai."
  type        = string
}

variable "region" {
  description = "One region for Cloud Run, the DICOM store and buckets (keep them together)."
  type        = string
  default     = "europe-west2"
}

variable "firestore_location" {
  description = "Firestore location (a region such as europe-west2, or a multi-region)."
  type        = string
  default     = "europe-west2"
}

variable "service_name" {
  type    = string
  default = "flowrad-viewer"
}

variable "service_account_id" {
  type    = string
  default = "flowrad-viewer-app"
}

variable "artifact_repo" {
  type    = string
  default = "flowrad-viewer"
}

variable "dataset_id" {
  type    = string
  default = "flowrad-viewer"
}

variable "dicom_store_id" {
  type    = string
  default = "studies"
}

variable "downloads_bucket" {
  description = "Globally unique bucket for public desktop installers, e.g. flowrad-viewer-downloads."
  type        = string
}

variable "frame_bucket" {
  description = "Optional private frame-cache bucket. Empty = none."
  type        = string
  default     = ""
}

variable "image" {
  description = "First container image (deploy.sh rolls later ones)."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "min_instances" {
  type    = number
  default = 0
}

variable "max_instances" {
  type    = number
  default = 10
}

variable "identity_api_key" {
  description = "Identity Platform web API key (public; restrict it to the site's referrers in the console)."
  type        = string
  default     = ""
}

variable "identity_auth_domain" {
  description = "Identity Platform auth domain, e.g. <project>.firebaseapp.com or a custom one."
  type        = string
  default     = ""
}

variable "public_origin" {
  type    = string
  default = "https://viewer.flowrad.ai"
}

variable "custom_domain" {
  description = "Custom domain to map (viewer.flowrad.ai). Empty = use the run.app URL."
  type        = string
  default     = ""
}

variable "github_repository" {
  description = "owner/repo allowed to upload installers (Workload Identity Federation)."
  type        = string
  default     = "drskatyal/flowrad-viewer"
}

variable "desktop_downloads_live" {
  description = "Show Windows/macOS download links. Keep false until builds are code-signed and self-updating (docs/DESKTOP_RELEASE_READINESS.md)."
  type        = bool
  default     = false
}
