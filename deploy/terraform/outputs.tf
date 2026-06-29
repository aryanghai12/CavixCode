output "namespace" {
  value = kubernetes_namespace.cavix.metadata[0].name
}
output "air_gapped" {
  value       = var.air_gapped
  description = "When true, a deny-all-egress NetworkPolicy is enforced."
}
output "verify_airgap_command" {
  value = "kubectl -n ${kubernetes_namespace.cavix.metadata[0].name} get networkpolicy cavix-default-deny-egress -o yaml"
}
