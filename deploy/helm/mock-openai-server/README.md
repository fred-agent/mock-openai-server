# mock-openai-server Helm chart

Quick start:

```bash
helm install mock-openai ./deploy/helm/mock-openai-server \
  --set image.repository=your-registry/mock-openai-server \
  --set image.tag=latest
```

Key values:
- `config`: inlined `config.yaml` mounted into the pod.
- `service.port`: must match `config.server.port` (defaults to 8383).
- `ingress.*`: enable/route external access.
- `monitoring.summaryLogIntervalMs`: controls periodic summary logs (set to 0 to disable).
