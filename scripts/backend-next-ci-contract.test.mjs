/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { load } from 'js-yaml';

const workflow = load(readFileSync(new URL('../.github/workflows/test-backend-next.yml', import.meta.url), 'utf8'));
const lanes = ['contracts', 'checks', 'integration', 'process'];
const setupCommands = ['pnpm install --frozen-lockfile --filter backend-next...', 'git diff --exit-code pnpm-lock.yaml'];
const build = 'pnpm --filter backend-next... build';
const owned = {
 contracts: ['node scripts/backend-contract-inventory.mjs --check', 'node --test scripts/*-contract*.test.mjs'],
 checks: ['pnpm --filter backend-upstream sync:check', build, 'pnpm --filter backend-next... typecheck', 'pnpm --filter backend-next... lint', 'pnpm --filter backend-upstream test', 'pnpm --filter backend-next test'],
 integration: [build, 'pnpm --filter backend-next test:integration', 'pnpm --filter backend-next test:acceptance'],
 process: [build, 'pnpm --filter backend-next test:process'],
};
const originalPaths = [
 'docs/superpowers/compatibility/role/**', 'docs/superpowers/compatibility/backend-inventory/**',
 'scripts/backend-contract-inventory*.mjs', 'docs/superpowers/compatibility/note/**',
 'docs/superpowers/compatibility/remote-user/**', 'scripts/*-contract*.test.mjs',
 'docs/superpowers/compatibility/ap-deliver/**', 'packages/backend-next/**', 'packages/backend-upstream/**',
 'packages/shared/eslint.config.js', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', '.node-version',
 '.github/workflows/test-backend-next.yml',
];
const services = {
 postgres: { image: 'postgres:18', env: { POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: 'foundation-test-only', POSTGRES_DB: 'backend_next_test' }, ports: ['55432:5432'], options: '--health-cmd "pg_isready -U postgres -d backend_next_test" --health-interval 1s --health-timeout 3s --health-retries 30' },
 redis: { image: 'redis:8', ports: ['56379:6379'], options: '--health-cmd "redis-cli ping" --health-interval 1s --health-timeout 3s --health-retries 30' },
 meilisearch: { image: 'getmeili/meilisearch:v1.3.4', env: { MEILI_NO_ANALYTICS: 'true', MEILI_ENV: 'development' }, ports: ['57779:7700'], options: '--health-cmd "curl -f http://localhost:7700/health" --health-interval 1s --health-timeout 3s --health-retries 30' },
};

test('existing triggers remain and every script helper change triggers the checks', () => {
 assert.deepEqual(workflow.on.push.branches, ['master', 'develop']);
 assert.equal(Object.hasOwn(workflow.on, 'workflow_dispatch'), true);
 for (const event of ['push', 'pull_request']) {
  const paths = workflow.on[event].paths;
  assert(paths.includes('scripts/**'));
  for (const path of originalPaths) assert(paths.includes(path) || (path.startsWith('scripts/') && paths.includes('scripts/**')), `${event} lost ${path}`);
 }
 assert.equal(workflow.concurrency, undefined);
});

test('four independent lanes preserve each validation once, plus explicit per-runner preparation', () => {
 assert.deepEqual(Object.keys(workflow.jobs).sort(), [...lanes, 'foundation'].sort());
 const allCommands = [];
 for (const id of lanes) {
  const job = workflow.jobs[id];
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.equal(job.needs, undefined, `${id} must start independently`);
  assert.equal(job.if, undefined);
  assert.equal(job['continue-on-error'], undefined);
  assert.equal(job.strategy, undefined);
  const steps = job.steps;
  const commands = steps.filter(s => s.run).map(s => s.run);
  assert.deepEqual(commands, [...setupCommands, ...owned[id]], `${id} changed or omitted a check`);
  allCommands.push(...commands);
  assert.equal(steps.find(s => s.uses?.startsWith('actions/checkout@')).with['fetch-depth'], 0);
  assert(steps.some(s => s.uses?.startsWith('pnpm/action-setup@')));
  assert.deepEqual(steps.find(s => s.uses?.startsWith('actions/setup-node@')).with, { 'node-version-file': '.node-version', cache: 'pnpm' });
  for (const step of steps) {
   assert.equal(step['continue-on-error'], undefined);
   assert.equal(step.if, undefined);
   assert.equal(step['working-directory'], undefined);
  }
 }
 for (const command of Object.values(owned).flat().filter(c => c !== build)) assert.equal(allCommands.filter(c => c === command).length, 1, command);
 for (const command of setupCommands) assert.equal(allCommands.filter(c => c === command).length, 4);
 assert.equal(allCommands.filter(c => c === build).length, 3);
});

test('runtime lanes retain existing services and only integration gets split-server Pub/Sub Redis', () => {
 for (const id of ['contracts', 'checks', 'foundation']) assert.equal(workflow.jobs[id].services, undefined);
 assert.deepEqual(workflow.jobs.process.services, services);
 assert.deepEqual(workflow.jobs.integration.services, { ...services, 'redis-pubsub': { image: 'redis:8', ports: ['56380:6379'], options: '--health-cmd "redis-cli ping" --health-interval 1s --health-timeout 3s --health-retries 30' } });
});

test('the required foundation check always examines every lane and cannot be silently skipped', () => {
 const gate = workflow.jobs.foundation;
 assert.equal(gate.name ?? 'foundation', 'foundation');
 assert.deepEqual(gate.needs, lanes);
 assert.equal(gate.if, '${{ always() }}');
 assert.equal(gate['runs-on'], 'ubuntu-latest');
 assert.equal(gate['continue-on-error'], undefined);
 assert.equal(gate.steps.length, 1);
 assert.deepEqual(gate.steps[0].env, { CHECK_RESULTS: '${{ toJSON(needs) }}' });
 assert.equal(gate.steps[0].if, undefined);
 assert.equal(gate.steps[0]['continue-on-error'], undefined);
});

function runGate(results) {
 const step = workflow.jobs.foundation.steps[0];
 assert.equal(typeof step.run, 'string', 'foundation needs an executable gate');
 return spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], {
  encoding: 'utf8', env: { ...process.env, CHECK_RESULTS: typeof results === 'string' ? results : JSON.stringify(results) },
 });
}
const successful = () => Object.fromEntries(lanes.map(name => [name, { result: 'success', outputs: {} }]));
test('actual YAML gate succeeds only with all four successful results', () => {
 const result = runGate(successful());
 assert.equal(result.status, 0, result.stderr);
});
for (const lane of lanes) {
 for (const status of ['failure', 'cancelled', 'skipped', 'unknown']) {
  test(`actual YAML gate rejects ${lane} ${status}`, () => {
   const results = successful(); results[lane].result = status;
   assert.notEqual(runGate(results).status, 0);
  });
 }
 test(`actual YAML gate rejects missing ${lane}`, () => {
  const results = successful(); delete results[lane];
  assert.notEqual(runGate(results).status, 0);
 });
}
for (const [name, value] of [['extra dependency', { ...successful(), extra: { result: 'success' } }], ['malformed JSON', '{'], ['null', 'null'], ['empty results', {}]]) {
 test(`actual YAML gate rejects ${name}`, () => assert.notEqual(runGate(value).status, 0));
}
