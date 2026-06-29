# Cavix self-host

Production deployment for self-hosted and **air-gapped** Cavix.

## Layout
```
deploy/
  helm/cavix/        Helm chart (deny-all-egress NetworkPolicy, hardened pods, in-cluster model)
  terraform/         namespace + license secret + helm_release (cluster-agnostic)
  sign-images.sh     cosign signing + offline verification
```

## Quick install (connected cluster)
```bash
helm lint deploy/helm/cavix
helm install cavix deploy/helm/cavix -n cavix --create-namespace \
  --set airGapped=false --set image.registry=registry.internal/cavix
```

## Air-gapped install
1. Mirror + sign images into your internal registry:
   ```bash
   COSIGN_PASSWORD=… deploy/sign-images.sh registry.internal/cavix 0.3.0 cosign.key
   ```
2. Create the offline license secret and deploy with Terraform:
   ```bash
   cd deploy/terraform
   terraform apply -var air_gapped=true -var license_file=./cavix-license.json \
     -var image_registry=registry.internal/cavix
   ```
3. With `airGapped=true` the chart renders `cavix-default-deny-egress`
   (`egress: []`) and runs the in-cluster self-hosted model. There is **no rule
   permitting `0.0.0.0/0`** anywhere in the chart.

## Prove nothing leaves the cluster
```bash
kubectl -n cavix get networkpolicy cavix-default-deny-egress -o yaml   # egress: []
kubectl -n cavix exec deploy/cavix-orchestrator -- \
  sh -c 'wget -T3 -qO- https://api.anthropic.com || echo BLOCKED'      # → BLOCKED
```
Two independent layers enforce this: the **NetworkPolicy** (kernel/CNI) denies the
packet, and the gateway **EgressGuard** (application) refuses any host that is not
the in-cluster model. See `docs/compliance/AIR_GAPPED_DATA_FLOW.md`.

## Validation
`helm lint` and `helm template deploy/helm/cavix | kubectl apply --dry-run=server -f -`
validate the chart against the API server before install.
