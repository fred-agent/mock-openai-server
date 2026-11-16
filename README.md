### Shared k3d benchmark deployment

With the `fred` k3d cluster running, run these commands from
`fred-deployment-factory` (the mock checkout supplies its own Helmfile):

```bash
make k3d-app-validate FRED=bench DIR="$HOME/Work/common/mock-openai-server"
make k3d-app FRED=bench DIR="$HOME/Work/common/mock-openai-server"
```

Validation only renders manifests. Deployment builds a content-tagged image,
imports it into k3d, creates `fred-bench` if needed, and waits for the mock.
Repeat the deployment command after changing code or configuration; configuration
changes restart the pod automatically. No Fred deployment is changed.

Both Swift and Weaver can use the same internal base URL:
`http://mock-openai-server.fred-bench.svc.cluster.local:8383/v1`, model `gpt-4o`,
and disposable mock API key `key-1`. Configure their model selection separately.

`deploy/k3d/values.yaml` sets one replica, one fixed text response, no tool calls,
and a fixed asynchronous delay of 1000 ms. It overrides the chart configuration;
the root `config.yaml` is only the local `make dev` configuration. The mock sends
text in one SSE chunk, not a paced token stream. CPU has a request but no limit;
watch resource use to ensure the mock itself is not saturated.

To override the delay without editing the checkout, create a values file:

```yaml
config:
  responseDelay:
    enable: true
    minDelayMs: 2000
    maxDelayMs: 2000
```

Pass its absolute path as `VALUES=/path/to/latency.yaml` to the validation and
deployment commands. Set `enable: false` for the no-delay baseline.

```bash
kubectl --context k3d-fred -n fred-bench logs -f deployment/mock-openai-server
kubectl --context k3d-fred -n fred-bench port-forward service/mock-openai-server 8383:8383
# In another terminal:
curl --fail http://localhost:8383/health
# From fred-deployment-factory; removes the release, leaves the namespace:
make k3d-app-uninstall FRED=bench DIR="$HOME/Work/common/mock-openai-server"
```

### Opt-in deterministic chat benchmarks

Start a **separate local instance** (no deployment change is needed):

```bash
MOCK_BENCHMARK_PROFILE=reference HOST=127.0.0.1 PORT=0 npm run server
# or: MOCK_BENCHMARK_PROFILE=streaming HOST=127.0.0.1 PORT=0 npm run server
```

`PORT=0` selects a free port, printed at startup. An empty/unset profile preserves
all existing behavior. Unknown profiles fail at startup. Profiles affect only
marked `/v1/chat/completions` requests; unmarked chat, tools and other endpoints
keep their configured behavior. Existing authentication and configured chat model
names still apply. The profile replaces `responseDelay` for marked requests only.

- `reference`: asynchronous 1000 ms initial wait, then one short text response.
  With `stream: true`, sends one content fragment, a separate stop event and DONE.
- `streaming`: requires `stream: true`; asynchronous 1000 ms initial wait, then
  **100 text fragments**, with 50 ms between fragments (99 intervals, nominal
  5950 ms total), followed by a separate stop event and `data: [DONE]`.
  Fragment 1 is the ACK below; fragments 2–100 contain
  `MOCK_BENCH_FRAGMENT_V1 2/100\n` through `MOCK_BENCH_FRAGMENT_V1 100/100\n`.
  SSE events are logical fragments; network reads may combine several events.

Each benchmark user message contains one standalone line (surrounding prompt text
is allowed; string content and `type: text` content parts are supported):

```text
MOCK_BENCH_V1 {"conversation":"run-a-conversation-1","turn":1,"nonce":"unique-turn-1"}
```

Only these three keys are accepted. `conversation` and `nonce` are 1–128 characters
from `[A-Za-z0-9_.:-]`; `turn` is a positive safe integer. The last user message
must contain a marker if any user message is marked. Duplicate markers within a
user message and malformed markers return HTTP 400. Use a fresh conversation ID
per conversation and a fresh nonce per turn. The response begins with one line:

```text
MOCK_BENCH_ACK_V1 {"conversation":"run-a-conversation-1","turn":2,"nonce":"unique-turn-2","previous":[{"conversation":"run-a-conversation-1","turn":1,"nonce":"unique-turn-1"}]}
```

The current triple comes from the last user marker. `previous` lists **all observed
prior user markers in order**, including duplicates, missing turns or foreign
conversation IDs as received; no server-side conversation state is kept. System
and assistant messages are not evidence. A client must compare the current triple
and the complete `previous` list against its expected conversation history (empty
on turn 1), and check fragment numbering and terminal SSE events. This detects
missing/mixed user history; it does not prove retention of unmarked text or of
assistant history, nor correctness of any reasoning.

Marked requests return text only, never tool calls. `tools` definitions and
`tool_choice: auto/none` are accepted; forced tools, `n` other than 1 and non-text
`response_format` return HTTP 400. Sampling, token budgets and stop sequences are
ignored for this fixed benchmark payload. The ACK grows with marked history.
There is no tokenizer: non-streaming `usage` is omitted, SSE `usage` is null and
`include_usage` produces no usage-only event. Do not report fragments as tokens
or derive token throughput from these profiles. Timings are nominal lower bounds:
event-loop scheduling and socket backpressure can lengthen them. Disconnects
cancel pending waits and stop emission, including while waiting for socket drain.

Run `npm test` (Node.js 20+). Tests use temporary configuration files and isolated
servers on ephemeral loopback ports; they never contact the live mock or Fred.
They cover profile opt-in, evidence, concurrent reference requests, real paced
SSE, legacy text/tool behavior, validation, backpressure and cancellation.

### Mock OpenAI Server 
1. Nodejs express server app to faithfully mock all important OpenAI endpoints (chat, embeddings, image, audio and models).
2. All existing SDK's and apps should work as-is by changing just the endpoint and optionally api key (check `apiKeys` in config.yaml).
3. Helpful to save on your LLM API call costs while developing/testing agents or developing other apps. Also, helpful to return reproducible and configurable outputs while developing/testing.  
4. All models, their configurations, sample responses and server settings are configurable through `config.yaml`.

### Implemented
1. `/chat/completions`
2. `/embeddings`
3. `/images/generations`
4. `/images/variations`
5. `/images/edits`
6. `/audio/speech`
7. `/audio/transcriptions`
8. `/audio/translations`
9. `/models`
10. `/models/{model}`

### Not Implemented
> You most probably are not using these
1. Logits, modalities, prediction, and response_format->json_schema in `/chat/completions`.
2. Only `aac` output format is NOT supported in `/audio/speech` endpoint. Rest all ARE supported. `ffmpeg` related, nothing related to code.

### Installation
1. Clone the repo (`git clone https://github.com/freakynit/mock-openai-server.git`), `cd` into it, and do `npm i`
2. Install ffmpeg binary separately if audio endpoints are not working (should not be needed though).
3. Start server: `node src/server.js` or `npm run server`
4. Set api base (and optionally api key) in your client apps or openai SDK's to: `http://localhost:8080/v1`
5. Checkout `src/examples.js` for example usages of all supported endpoints (start looking from bottom of the file).

### Understanding config.yaml
This configuration file defines server settings, model configurations, and supported functionalities for text, image, audio, and embeddings.
1. **General Settings**:
    - `publicFilesDirectory`: Directory for storing public/generated files (`public`).
    - `server`: Host and port configuration (`localhost:8080`).
    - `organizationName`: Name of the organization (`my sample org`).
    - `apiKeys`: List of API keys used for authorization. Leave it empty to allow anonymous access.

2. **Response Delay**:
    - Option to enable/disable simulated response delays.
    - Configurable delay range in milliseconds.

3. **Model Configurations**:
    - **Chat Models**: Multiple text-based models (e.g., `chatgpt-4o-latest`, `model-2`). Add more if needed.
        - Maximum token limits and sample responses are defined.
    - **Visual Language Models (VLM)**:
        - Image generation models (e.g., `dall-e-2`, `dall-e-3`) with configurations for resolution, quality, and styles.
        - Support for generating and editing images with sample responses provided.
    - **Audio Models**:
        - Text-to-speech (TTS) models with voice options, supported formats, and duration limits.
        - Audio transcription and translation with sample responses and supported formats (e.g., `json`, `text`).
    - **Embeddings**:
        - Text embedding models with maximum token and dimension limits, supporting different encoding formats.

4. **Functionalities**:
    - Text-based tools (e.g., summation, weather fetching, string reversal) using regex-based triggers.
    - Extensive support for generating sample responses in text, JSON, and media (images/audio).

### Understanding tool use
1. Unlike other sample responses, the tool use requires one small extra step.
2. You just need to declare the regex that will be used to match the prompt when tool use is requested.
3. See `modelConfigs -> chat -> tools` in `config.yaml` for examples (they are simple enough). Sample:
```yaml
    tools:
       functions:
          - functionName: "calculate_sum"
            arguments: { "a": 10, "b": 20 }
            regexToMatchAgainstPrompt: |
               .*sum.*
          - functionName: "fetch_weather"
            arguments: { "location": "Boston, MA", "unit": "imperial" }
            regexToMatchAgainstPrompt: |
               .*weather.* 
```

### Understanding Sample Responses
1. Except for `/embeddings` endpoint, all other endpoints allow specifying sample responses in config.yaml.
2. For `/embeddings`, responses are always generated on the fly. But, the server makes sure to generate same tokens for the same given input.
3. Media endpoints: `/audio/speech` and `/images/{generations,variations,edits}` also support generating media dynamically. Use `generationFrom: generated` for these if needed.
4. `/models` endpoint simply traverses all models listed in config.yaml across different modalities and returns them.
5. For adding new response strategies, look into relevant source files under `src/generators` path. You just need to implement one simple method for all except `/chat`, which needs two methods.

### Other Important Points
1. When using dynamically generated media, these files are generated in `src/public` (more precisely: `src/${publicFilesDirectory}`) by default and are NOT cleaned.
2. Do not forget to put `/v1` in your client SDK's or apps when configuring mock server endpoint.
3. Code requires some good refactoring... inputs and contributions are welcome.

### Building and running docker image
> Make sure to keep port same as what's mentioned in config.yaml
```shell
docker build -t mock-openai-server --build-arg PORT=8080 .
docker run -p 8080:8080 mock-openai-server
```
