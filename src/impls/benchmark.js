import {setTimeout as sleep} from 'node:timers/promises';
import {once} from 'node:events';
import {getId, getTimestampSeconds} from '../utils.js';

const markerPrefix = 'MOCK_BENCH_V1 ';
const ackPrefix = 'MOCK_BENCH_ACK_V1 ';

export function benchmarkProfile(value = '') {
    if (!['', 'reference', 'streaming'].includes(value)) {
        throw new Error('MOCK_BENCHMARK_PROFILE must be reference, streaming, or empty');
    }
    return value;
}

// Only user text is evidence: never trust a claimed history in the current prompt.
export function benchmarkEvidence(messages) {
    const users = (Array.isArray(messages) ? messages : []).filter(m => m?.role === 'user');
    const perUser = users.map(message => {
        const text = typeof message.content === 'string' ? message.content :
            (Array.isArray(message.content) ? message.content.filter(p => p?.type === 'text').map(p => p.text).join('\n') : '');
        return text.split(/\r?\n/).map(line => line.trim()).filter(line => line === markerPrefix.trimEnd() || line.startsWith(markerPrefix));
    });
    if (!perUser.some(lines => lines.length)) return null;
    if (perUser.at(-1).length !== 1 || perUser.some(lines => lines.length > 1)) {
        throw new Error('One MOCK_BENCH_V1 marker per marked user message is required, including the last user message');
    }
    const markers = perUser.flat().map(line => {
        const marker = JSON.parse(line.slice(markerPrefix.length));
        const id = /^[A-Za-z0-9_.:-]{1,128}$/;
        if (!marker || Object.keys(marker).sort().join(',') !== 'conversation,nonce,turn' ||
            typeof marker.conversation !== 'string' || !id.test(marker.conversation) ||
            typeof marker.nonce !== 'string' || !id.test(marker.nonce) ||
            !Number.isSafeInteger(marker.turn) || marker.turn < 1) {
            throw new Error('Marker requires conversation and nonce (1–128 ASCII letters/digits/_.:-), and a positive safe integer turn');
        }
        return {conversation: marker.conversation, turn: marker.turn, nonce: marker.nonce};
    });
    return {...markers.at(-1), previous: markers.slice(0, -1)};
}

export async function benchmarkResponse(req, res, profile, models) {
    if (!profile) return false;
    let evidence;
    try {
        evidence = benchmarkEvidence(req.body.messages);
        if (!evidence) return false;
        if (!Object.hasOwn(models, req.body.model)) throw new Error('Unknown benchmark chat model');
        if (profile === 'streaming' && req.body.stream !== true) throw new Error('The streaming benchmark profile requires stream: true');
        if (req.body.n != null && req.body.n !== 1) throw new Error('Benchmark supports n: 1 only');
        if (req.body.tool_choice && !['none', 'auto'].includes(req.body.tool_choice)) throw new Error('Benchmark cannot force tool calls');
        if (req.body.response_format && req.body.response_format.type !== 'text') throw new Error('Benchmark requires text response_format');
    } catch (error) {
        res.status(400).json({error: {message: error.message, type: 'invalid_request_error'}});
        return true;
    }

    const controller = new AbortController();
    const {signal} = controller;
    const abort = () => controller.abort();
    res.once('close', abort);
    if (res.destroyed) abort();
    const envelope = {id: getId(), created: getTimestampSeconds(), model: req.body.model};
    const content = `${ackPrefix}${JSON.stringify(evidence)}\n`;
    const write = async data => {
        signal.throwIfAborted();
        if (!res.write(data)) await once(res, 'drain', {signal});
    };
    const chunk = (delta, finishReason = null) => `data: ${JSON.stringify({
        ...envelope, object: 'chat.completion.chunk',
        choices: [{index: 0, delta, finish_reason: finishReason}], usage: null,
    })}\n\n`;
    try {
        await sleep(1000, undefined, {signal});
        if (!req.body.stream) {
            res.json({...envelope, object: 'chat.completion', choices: [{
                index: 0, message: {role: 'assistant', content}, finish_reason: 'stop',
            }]});
        } else {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            const count = profile === 'streaming' ? 100 : 1;
            for (let i = 0; i < count; i++) {
                if (i) await sleep(50, undefined, {signal});
                // The ACK is the first fragment; numbered padding makes loss detectable.
                await write(chunk({...(i === 0 ? {role: 'assistant'} : {}),
                    content: i === 0 ? content : `MOCK_BENCH_FRAGMENT_V1 ${i + 1}/100\n`}));
            }
            await write(chunk({}, 'stop'));
            await write('data: [DONE]\n\n');
            res.end();
        }
    } catch (error) {
        if (!signal.aborted) {
            if (!res.headersSent) res.status(500).json({error: {message: 'Benchmark response failed'}});
            else res.destroy(error);
        }
    } finally {
        res.off('close', abort);
    }
    return true;
}
