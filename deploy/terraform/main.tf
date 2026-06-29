# Cavix self-host: namespace + Helm release. Cluster-agnostic (EKS/GKE/AKS/on-prem)
# — bring your own kubeconfig. For air-gapped clusters, point var.image_registry at
# your internal registry and run deploy/sign-images.sh to mirror + sign images.

terraform {
  required_version = ">= 1.5"
  required_providers {
    kubernetes = { source = "hashicorp/kubernetes", version = ">= 2.30" }
    helm       = { source = "hashicorp/helm", version = ">= 2.14" }
  }
}

provider "kubernetes" {
  config_path = var.kubeconfig
}
provider "helm" {
  kubernetes { config_path = var.kubeconfig }
}

resource "kubernetes_namespace" "cavix" {
  metadata {
    name = var.namespace
    labels = {
      "pod-security.kubernetes.io/enforce" = "restricted" # hardened by default
      "app.kubernetes.io/part-of"          = "cavix"
    }
  }
}

# License secret (offline Ed25519 license file) — never leaves the cluster.
resource "kubernetes_secret" "license" {
  metadata {
    name      = "cavix-license"
    namespace = kubernetes_namespace.cavix.metadata[0].name
  }
  data = { "license.json" = file(var.license_file) }
}

resource "helm_release" "cavix" {
  name      = "cavix"
  namespace = kubernetes_namespace.cavix.metadata[0].name
  chart     = "${path.module}/../helm/cavix"

  set {
    name  = "airGapped"
    value = var.air_gapped
  }
  set {
    name  = "image.registry"
    value = var.image_registry
  }
  set {
    name  = "image.tag"
    value = var.image_tag
  }
  set {
    name  = "model.servedModel"
    value = var.served_model
  }

  depends_on = [kubernetes_secret.license]
}
