import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import yaml from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const chart = 'deploy/helm/mock-openai-server';
const defaults = yaml.parse(readFileSync(`${root}${chart}/values.yaml`, 'utf8'));

function render(args = []) {
    const result = spawnSync('helm', ['template', 'mock-openai-server', chart, ...args],
        {cwd: root, encoding: 'utf8'});
    if (result.error) throw result.error;
    return result;
}

function manifests(args) {
    const result = render(args);
    assert.equal(result.status, 0, result.stderr);
    const docs = yaml.parseAllDocuments(result.stdout).map(doc => doc.toJSON());
    const deployment = docs.find(doc => doc.kind === 'Deployment');
    const container = deployment.spec.template.spec.containers[0];
    const config = yaml.parse(docs.find(doc => doc.kind === 'ConfigMap').data['config.yaml']);
    return {deployment, container, config};
}

test('generic chart is neutral and preserves configured model arrays and tools', () => {
    const {container, config} = manifests([]);
    assert.equal(container.env.find(item => item.name === 'MOCK_BENCHMARK_PROFILE').value, '');
    assert.deepEqual(config.modelConfigs, defaults.config.modelConfigs);
    assert.deepEqual(config.responseDelay, defaults.config.responseDelay);
});

const k3dArgs = ['-f', 'deploy/k3d/values.yaml'];
test('k3d without an opt-in keeps the existing fixed response and no benchmark profile', () => {
    const {container, config} = manifests(k3dArgs);
    assert.equal(container.env.find(item => item.name === 'MOCK_BENCHMARK_PROFILE').value, '');
    assert.deepEqual(config.modelConfigs.chat.models, defaults.config.modelConfigs.chat.models);
    assert.deepEqual(config.modelConfigs.chat.sampleResponses, ['Mock benchmark response.']);
    assert.deepEqual(config.modelConfigs.chat.tools.functions, []);
});

for (const profile of ['none', 'reference', 'streaming']) {
    test(`k3d ${profile} changes only the profile environment in the pod template`, () => {
        const baseline = manifests(k3dArgs);
        const actual = manifests([...k3dArgs, '--set-string', `benchmark.profile=${profile}`]);
        const environment = actual.container.env.find(item => item.name === 'MOCK_BENCHMARK_PROFILE');
        assert.equal(environment.value, profile === 'none' ? '' : profile);
        assert.equal(actual.container.env.filter(item => item.name === environment.name).length, 1);
        assert.deepEqual(actual.config, baseline.config);
        environment.value = '';
        assert.deepEqual(actual.deployment, baseline.deployment);
    });
}

test('invalid profiles fail during rendering before a rollout', () => {
    for (const profile of ['typo', '', 'REFERENCE']) {
        const result = render([...k3dArgs, '--set-string', `benchmark.profile=${profile}`]);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /benchmark[./]profile/);
        assert.equal(result.stdout, '');
    }
    for (const profile of ['null', 'true']) {
        const result = render([...k3dArgs, '--set', `benchmark.profile=${profile}`]);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /benchmark/);
        assert.equal(result.stdout, '');
    }
});
