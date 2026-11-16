# mock-openai-server Helm chart

Quick start:

```bash
helm install mock-openai ./deploy/helm/mock-openai-server \
  --set image.repository=your-registry/mock-openai-server \
  --set image.tag=latest
```

Key values:
- `config`: inlined `config.yaml` mounted into the pod.
- `benchmark.profile`: `none` (default), `reference`, or `streaming`; opt-in
  behavior for marked chat requests. `none` renders an empty
  `MOCK_BENCHMARK_PROFILE`; other values render the selected profile into the pod.
  Unknown values fail schema validation before rollout. Model lists, sample
  response arrays, tools and ordinary requests retain their configuration.
- `service.port`: must match `config.server.port` (defaults to 8383).
- `ingress.*`: enable/route external access.
- `config.monitoring.summaryLogIntervalMs`: controls periodic summary logs (set to 0 to disable).

Persist the selection in your deployment values file:

```yaml
benchmark:
  profile: reference
```

Pass this file with `-f /absolute/path/benchmark.yaml` on each Helm install or
upgrade. Direct selection is also available with
`--set-string benchmark.profile=streaming`. The profile is part of the pod
template and survives pod recreation; no imperative environment patch is needed.
The root README describes factory `BENCH=reference|streaming` and marker format.
Run `npm run test:helm` from the checkout for offline rendering checks.
