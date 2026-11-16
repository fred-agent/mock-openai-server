import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {benchmarkEvidence, benchmarkProfile, benchmarkResponse} from '../src/impls/benchmark.js';

const marker = (conversation, turn, nonce = `n${turn}`) => ({role: 'user',
    content: `MOCK_BENCH_V1 ${JSON.stringify({conversation, turn, nonce})}`});

test('profile opt-in fails closed for unknown values', () => {
    assert.equal(benchmarkProfile(), '');
    assert.equal(benchmarkProfile('reference'), 'reference');
    assert.equal(benchmarkProfile('streaming'), 'streaming');
    assert.throws(() => benchmarkProfile('typo'));
});

test('evidence preserves observed order, foreign conversations and missing turns', () => {
    const messages = [marker('foreign', 7), marker('a', 1),
        {role: 'assistant', content: marker('invented', 99).content},
        {role: 'system', content: marker('system', 99).content}, marker('a', 3)];
    assert.deepEqual(benchmarkEvidence(messages), {conversation: 'a', turn: 3, nonce: 'n3',
        previous: [{conversation: 'foreign', turn: 7, nonce: 'n7'}, {conversation: 'a', turn: 1, nonce: 'n1'}]});
});

test('user text parts and surrounding prompt text work without retaining state', () => {
    assert.deepEqual(benchmarkEvidence([{role: 'user', content: [{type: 'text', text: 'Instructions'},
        {type: 'text', text: `\r\n ${marker('c', 2, 'unique').content} \r\nQuestion` }]}]),
    {conversation: 'c', turn: 2, nonce: 'unique', previous: []});
    assert.equal(benchmarkEvidence([{role: 'user', content: 'ordinary prompt'}]), null);
});

test('rejects bare markers but leaves similar non-marker words untouched', () => {
    for (const content of ['MOCK_BENCH_V1', 'MOCK_BENCH_V1 ', ' MOCK_BENCH_V1  \r\n']) {
        assert.throws(() => benchmarkEvidence([{role: 'user', content}]));
    }
    for (const content of ['MOCK_BENCH_V10', 'MOCK_BENCH_V1_suffix', 'prefix MOCK_BENCH_V1']) {
        assert.equal(benchmarkEvidence([{role: 'user', content}]), null);
    }
});

test('rejects malformed, ambiguous and forged-history markers', () => {
    for (const content of ['MOCK_BENCH_V1 {',
        'MOCK_BENCH_V1 {"conversation":"c","turn":0,"nonce":"n"}',
        'MOCK_BENCH_V1 {"conversation":"c","turn":1,"nonce":"n","previous":[]}',
        `${marker('c', 1).content}\n${marker('c', 2).content}`]) {
        assert.throws(() => benchmarkEvidence([{role: 'user', content}]));
    }
    assert.throws(() => benchmarkEvidence([marker('c', 1), {role: 'user', content: 'missing current marker'}]));
});

function response(write) {
    const res = new EventEmitter();
    res.setHeader = () => {};
    res.write = write;
    res.end = () => assert.fail('cancelled response must not end normally');
    res.json = () => assert.fail('cancelled response must not send JSON');
    return res;
}

const req = {body: {model: 'gpt-4o', stream: true, messages: [marker('cancel', 1)]}};

test('disconnect cancels the initial timer and removes the close listener', async () => {
    const res = response(() => assert.fail('no writes before initial delay'));
    const start = performance.now();
    const pending = benchmarkResponse(req, res, 'streaming', {'gpt-4o': {}});
    res.emit('close');
    assert.equal(await pending, true);
    assert.ok(performance.now() - start < 300);
    assert.equal(res.listenerCount('close'), 0);
});

test('disconnect cancels pacing after the first fragment', async () => {
    let writes = 0;
    const res = response(() => {
        writes++;
        setTimeout(() => res.emit('close'), 5);
        return true;
    });
    const start = performance.now();
    await benchmarkResponse(req, res, 'streaming', {'gpt-4o': {}});
    assert.equal(writes, 1);
    assert.ok(performance.now() - start < 1800);
    assert.equal(res.listenerCount('close'), 0);
});

test('backpressure waits for drain and remains cancellable', async () => {
    let writes = 0;
    const res = response(() => {
        writes++;
        setTimeout(() => res.emit('close'), 80);
        return false;
    });
    await benchmarkResponse(req, res, 'streaming', {'gpt-4o': {}});
    assert.equal(writes, 1);
    assert.equal(res.listenerCount('drain'), 0);
    assert.equal(res.listenerCount('close'), 0);
});
