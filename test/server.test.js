import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import yaml from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = yaml.parse(await readFile(path.join(root, 'config.yaml'), 'utf8'));
const marker = (conversation, turn, nonce = `n${turn}`) => ({role: 'user',
    content: `MOCK_BENCH_V1 ${JSON.stringify({conversation, turn, nonce})}`});
const ack = text => JSON.parse(text.split('\n')[0].slice('MOCK_BENCH_ACK_V1 '.length));

async function startServer(t, profile) {
    const cwd = await mkdtemp(path.join(tmpdir(), 'mock-benchmark-test-'));
    const localConfig = structuredClone(config);
    localConfig.responseDelay = {enable: true, minDelayMs: 250, maxDelayMs: 250};
    localConfig.monitoring = {summaryLogIntervalMs: 100};
    await writeFile(path.join(cwd, 'config.yaml'), yaml.stringify(localConfig));
    const child = spawn(process.execPath, [path.join(root, 'src/server.js')], {
        cwd, env: {...process.env, HOST: '127.0.0.1', PORT: '0', MOCK_BENCHMARK_PROFILE: profile},
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            child.kill();
            await exited;
        }
        await rm(cwd, {recursive: true, force: true});
    });
    let url;
    for (let i = 0; i < 200; i++) {
        url = output.match(/running at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
        if (url) break;
        if (child.exitCode !== null) assert.fail(output);
        await sleep(25);
    }
    assert.ok(url, `server startup timed out: ${output}`);
    const post = (body, extra = {}) => fetch(`${url}/v1/chat/completions`, {
        method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer key-1'},
        body: JSON.stringify({model: 'gpt-4o', messages: [marker('c', 1)], ...body}),
        signal: AbortSignal.timeout(15000), ...extra,
    });
    return {url, post, logs: () => output};
}

async function stream(response) {
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    let buffer = '';
    const events = [];
    for await (const bytes of response.body) {
        buffer += new TextDecoder().decode(bytes);
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
            const data = buffer.slice(0, end).slice('data: '.length);
            events.push({data: data === '[DONE]' ? data : JSON.parse(data), time: performance.now()});
            buffer = buffer.slice(end + 2);
        }
    }
    assert.equal(buffer, '');
    return events;
}

test('disabled profile keeps existing text and tool behavior, even for markers', async t => {
    const {post, url} = await startServer(t, '');
    const response = await post({});
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.ok(config.modelConfigs.chat.sampleResponses.includes(data.choices[0].message.content));
    assert.ok(data.usage.total_tokens > 0);
    const tools = [{type: 'function', function: {name: 'calculate_sum', parameters: {type: 'object'}}}];
    const toolResponse = await post({tools, tool_choice: {type: 'function', function: {name: 'calculate_sum'}}});
    assert.equal((await toolResponse.json()).choices[0].message.tool_calls[0].function.name, 'calculate_sum');
    assert.equal((await fetch(`${url}/health`)).status, 200);
});

test('reference runs concurrent requests independently after 1 s and observes actual history', async t => {
    const {post} = await startServer(t, 'reference');
    const start = performance.now();
    const responses = await Promise.all(['a', 'b', 'c'].map(async conversation => {
        const response = await post({messages: [marker(conversation, 1),
            {role: 'assistant', content: 'earlier response'}, marker(conversation, 2, 'fresh')]});
        assert.equal(response.status, 200);
        return response.json();
    }));
    const elapsed = performance.now() - start;
    assert.ok(elapsed >= 950 && elapsed < 2200, `concurrent duration: ${elapsed}`);
    responses.forEach((data, index) => {
        const conversation = ['a', 'b', 'c'][index];
        assert.deepEqual(ack(data.choices[0].message.content), {conversation, turn: 2, nonce: 'fresh',
            previous: [{conversation, turn: 1, nonce: 'n1'}]});
        assert.equal(data.usage, undefined);
    });
    const events = await stream(await post({stream: true}));
    assert.equal(events.length, 3); // content, stop, DONE
    assert.equal(events[0].data.choices[0].delta.role, 'assistant');
    assert.equal(events[1].data.choices[0].finish_reason, 'stop');
    assert.equal(events[2].data, '[DONE]');
});

test('streaming sends 100 paced content fragments, a stop event and DONE', async t => {
    const {post} = await startServer(t, 'streaming');
    const start = performance.now();
    const events = await stream(await post({stream: true, stream_options: {include_usage: true}}));
    assert.equal(events.length, 102);
    const fragments = events.slice(0, 100);
    assert.ok(fragments[0].time - start >= 950);
    assert.ok(fragments[99].time - start >= 5800);
    assert.ok(fragments[99].time - start < 12000);
    assert.ok(fragments[99].time - fragments[0].time >= 4800);
    assert.deepEqual(ack(fragments[0].data.choices[0].delta.content),
        {conversation: 'c', turn: 1, nonce: 'n1', previous: []});
    fragments.forEach((event, index) => {
        assert.equal(event.data.id, fragments[0].data.id);
        assert.equal(event.data.usage, null);
        assert.equal(event.data.choices[0].finish_reason, null);
        if (index) assert.equal(event.data.choices[0].delta.content, `MOCK_BENCH_FRAGMENT_V1 ${index + 1}/100\n`);
    });
    assert.deepEqual(events[100].data.choices[0], {index: 0, delta: {}, finish_reason: 'stop'});
    assert.equal(events[101].data, '[DONE]');
});

test('enabled profile keeps unmarked prompts and rejects invalid marked requests', async t => {
    const {post} = await startServer(t, 'streaming');
    const ordinary = await post({messages: [{role: 'user', content: 'ordinary prompt'}]});
    assert.ok(config.modelConfigs.chat.sampleResponses.includes((await ordinary.json()).choices[0].message.content));
    for (const body of [{stream: false}, {stream: true, model: 'unknown'}, {stream: true, n: 2},
        {stream: true, tool_choice: 'required'}, {stream: true, response_format: {type: 'json_object'}},
        {stream: true, messages: [{role: 'user', content: 'MOCK_BENCH_V1 invalid'}]},
        ...['MOCK_BENCH_V1', 'MOCK_BENCH_V1 '].map(content => ({stream: true, messages: [{role: 'user', content}]}))]) {
        const response = await post(body);
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error.type, 'invalid_request_error');
    }
    const denied = await post({stream: true}, {headers: {'Content-Type': 'application/json', Authorization: 'Bearer invalid'}});
    assert.equal(denied.status, 401);
});

test('real disconnects release in-flight metrics before and during streaming', async t => {
    const {post, logs} = await startServer(t, 'streaming');
    const controller = new AbortController();
    const pending = post({stream: true}, {signal: controller.signal});
    await sleep(120);
    controller.abort();
    await assert.rejects(pending, {name: 'AbortError'});
    await sleep(200);
    assert.match(logs().trim().split('\n').at(-1), /in_flight=0/);
    const response = await post({stream: true});
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    await sleep(200);
    assert.match(logs().trim().split('\n').at(-1), /in_flight=0/);
});
