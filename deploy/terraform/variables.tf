variable "kubeconfig" {
  type        = string
  default     = "~/.kube/config"
  description = "Path to the kubeconfig for the target cluster."
}
variable "namespace" {
  type    = string
  default = "cavix"
}
variable "air_gapped" {
  type        = bool
  default     = true
  description = "Deny all egress; use the in-cluster self-hosted model only."
}
variable "image_registry" {
  type        = string
  default     = "registry.internal/cavix"
  description = "Private/offline registry holding the cosign-signed Cavix images."
}
variable "image_tag" {
  type    = string
  default = "0.3.0"
}
variable "served_model" {
  type    = string
  default = "llama-3.1-70b-instruct"
}
variable "license_file" {
  type        = string
  description = "Path to the offline Ed25519-signed license JSON."
}
