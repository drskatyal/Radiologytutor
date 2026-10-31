variable "project_id" {
  description = "GCP project id. Live project: radlearn-app (display name RadLearn)."
  type        = string
  default     = "radlearn-app"
}

variable "region" {
  description = "Region for Cloud Run, the Healthcare dataset, Cloud NAT, and the frame bucket. They must match. europe-west2 is London; Atlas uses EUROPE_WEST_2."
  type        = string
  default     = "europe-west2"
}

variable "dataset_id" {
  type    = string
  default = "radlearn"
}

variable "dicom_store_id" {
  type    = string
  default = "radlearn-dicom"
}

variable "service_name" {
  type    = string
  default = "radlearn"
}

variable "service_account_id" {
  type    = string
  default = "radlearn-app"
}

variable "artifact_repo" {
  type    = string
  default = "radlearn"
}

variable "network_name" {
  type    = string
  default = "radlearn"
}

variable "subnet_name" {
  type    = string
  default = "radlearn-run"
}

variable "subnet_cidr" {
  type    = string
  default = "10.8.0.0/24"
}

variable "vpc_egress" {
  description = "Cloud Run Direct VPC egress. ALL_TRAFFIC uses Cloud NAT so Atlas can allow one IP. PRIVATE_RANGES_ONLY after Atlas Private Service Connect."
  type        = string
  default     = "ALL_TRAFFIC"
}

variable "frame_bucket" {
  description = "Globally unique GCS bucket for the private frame cache. Empty skips the bucket."
  type        = string
  default     = ""
}

variable "min_instances" {
  type    = number
  default = 1
}

variable "max_instances" {
  type    = number
  default = 10
}

variable "deploy_app" {
  description = "Create the Cloud Run service. Leave false until an image exists and secret versions have been added, then set app_image and apply again. deploy/gcp/deploy-app.sh is the usual path."
  type        = bool
  default     = false
}

variable "app_image" {
  description = "Artifact Registry image, including tag. Required when deploy_app is true."
  type        = string
  default     = ""
}

variable "public_url" {
  description = "https://…run.app origin for BETTER_AUTH_URL. Empty until the first deploy prints the URL."
  type        = string
  default     = ""
}

variable "mongodb_db" {
  description = "Database name inside the Atlas cluster. Cloud Run does not use JSON-on-disk."
  type        = string
  default     = "radlearn"
}

variable "gemini_model" {
  description = "GEMINI_MODEL on Cloud Run. Stable Gemini 3.8 Flash."
  type        = string
  default     = "gemini-3.8-flash"
}

variable "dicom_cdn_bucket" {
  description = "Globally unique PRIVATE GCS bucket for converted DICOM (HTJ2K + previews). Empty skips converted delivery entirely. Example: radlearn-app-dicom-cdn."
  type        = string
  default     = ""
}

variable "dicom_cdn_domain" {
  description = "Hostname for the Cloud CDN load balancer in front of dicom_cdn_bucket, e.g. dicom-cdn.radlearn.app. Empty: chunks are served by the app (/api/dicom-cdn/files)."
  type        = string
  default     = ""
}

variable "dicom_cdn_key_name" {
  description = "Cloud CDN signed-URL key name. The app reads it as DICOM_CDN_KEY_NAME."
  type        = string
  default     = "radlearn-dicom-1"
}

variable "dicom_cdn_signing_key" {
  description = "base64url 16-byte Cloud CDN signing key (same value as the DICOM_CDN_KEY secret). Required with dicom_cdn_domain."
  type        = string
  default     = ""
  sensitive   = true
}
