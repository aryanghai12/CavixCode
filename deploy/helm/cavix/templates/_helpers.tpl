{{- define "cavix.labels" -}}
app.kubernetes.io/part-of: cavix
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "cavix.image" -}}
{{ .Values.image.registry }}/{{ . }}:{{ $.Values.image.tag }}
{{- end -}}

{{- define "cavix.securityContext" -}}
runAsNonRoot: {{ .Values.podSecurity.runAsNonRoot }}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: {{ .Values.podSecurity.readOnlyRootFilesystem }}
capabilities:
  drop: ["ALL"]
seccompProfile:
  type: {{ .Values.podSecurity.seccompProfile }}
{{- end -}}
