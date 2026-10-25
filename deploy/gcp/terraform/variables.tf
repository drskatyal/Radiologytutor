variable "project_id" {
  description = "GCP project id. Placeholder until apply: your-gcp-project."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run, the Healthcare dataset, and the frame bucket. They must match. us-east4 pairs with Fly iad. asia-south1 if learners are in India."
  type        = string
  default     = "us-east4"
}

variable "dataset_id" {
  type    = string
  default = "flowrad"
}

variable "dicom_store_id" {
  type    = string
  default = "flowrad-dicom"
}

variable "service_name" {
  type    = string
  default = "flowrad-learn"
}

variable "service_account_id" {
  type    = string
  default = "flowrad-app"
}

variable "artifact_repo" {
  type    = string
  default = "flowrad"
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
  type    = string
  default = "flowrad"
}
