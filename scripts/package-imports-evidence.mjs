/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const evidencePath = 'docs/superpowers/compatibility/backend-inventory/package-imports-current-evidence.json';
const read = path => readFileSync(new URL(path, root));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const previous = '0af0eab138933f819193cd77f2a063bc600905fcd926cc8b4388253ef6053d4b';
const canonical = '7963787fa74a5b66a90eff2af0533c65ceab3d166d93444283739e0625df4a14';
const optionalRead = path => {
	try {
		return readFileSync(path);
	} catch (error) {
		if (error.code === 'ENOENT') {
			return null;
		}
		throw error;
	}
};
export const packageImportsPath = 'packages/backend-next/test/package-imports.test.ts';

export function validatePackageImportsEvidence(value, readFile = read, optional = optionalRead) {
	assert.equal(value.schemaVersion, 1);
	assert.equal(value.scope, 'package-imports-38-entities');
	assert.equal(value.entityCount, 38, 'package import entity count');
	assert.equal(value.previousSha256, previous, 'package import predecessor');
	assert.deepEqual(Object.keys(value.inputSha256).sort(), [packageImportsPath, ...['src/models/UserNotePining.ts', 'upstream-sync.json', 'exports/entities.ts', '.managed-files.json'].map(path => 'packages/backend-upstream/' + path)].sort());
	for (const [path, digest] of Object.entries(value.inputSha256)) {
		assert.equal(sha(projectUserMemoEntityInput(path, readFile(path))), digest, 'package import measured input');
	}
	const run = value.measurement;
	assert.equal(run.exitCode, 0, 'package import successful measurement');
	assert.deepEqual(run.tests, { numTotalTests: 3403, numPassedTests: 3403, numFailedTests: 0, numPendingTests: 0, success: true }, 'package import successful tests');
	assert.deepEqual(run.command, ['pnpm', '--filter', 'backend-next', 'test', '--reporter=json', '--outputFile=/tmp/tiramiss-pr270-ci-full-unit.json']);
	assert(Number.isFinite(Date.parse(run.startedAt)) && Date.parse(run.completedAt) >= Date.parse(run.startedAt));
	assert.equal(sha(JSON.stringify(value)), canonical, 'package import evidence identity');
	for (const [path, digest] of [[run.log, run.logSha256], [run.artifact, run.artifactSha256]]) {
		const bytes = optional(path);
		if (bytes === null) {
			continue;
		}
		assert.equal(sha(bytes), digest, 'package import actual artifact');
		if (path === run.artifact) {
			const actual = JSON.parse(bytes);
			assert.deepEqual(Object.fromEntries(Object.keys(run.tests).map(key => [key, actual[key]])), run.tests, 'package import actual test results');
		}
	}
}

// Only this test's measured identity changes; earlier runtime receipts retain their bytes.
export function packageImportsDigest(file, oldDigest, readFile = read, optional = optionalRead) {
	if (file !== packageImportsPath) {
		return oldDigest;
	}
	const value = JSON.parse(readFile(evidencePath));
	assert(oldDigest === previous || oldDigest === value.inputSha256[file], 'package import predecessor');
	validatePackageImportsEvidence(value, readFile, optional);
	return value.inputSha256[file];
}

// #294 Entity synchronization is additive; original package/collection receipts stay sealed.
const userMemoEntityProjection = {
  "packages/backend-upstream/.managed-files.json": {
    "currentSha256": "48bbbdcd10e4b90e03622a94ecb9539819963cecb7acaffa6ef9d24979c41410",
    "previousSha256": "e2a6859ffa1f6e0ac16db2c92b5b6a0a0a451d197ebd5672fbc3aff21250781a",
    "patches": [
      {
        "offset": 17767,
        "insert": "Memo.ts\",\n\t\"src/models/User",
        "previous": ""
      }
    ]
  },
  "packages/backend-upstream/exports/entities.ts": {
    "currentSha256": "05ff04e21dee5f38a108332c5c1e9bbdee734e8e8b8169f363674a39050e9146",
    "previousSha256": "a3ba9f949469c6d730cbdcdd070994b38dbc55980075397ffc6df4eccc6d03dc",
    "patches": [
      {
        "offset": 2343,
        "insert": "import { MiUserMemo } from '../src/models/UserMemo.js';\n",
        "previous": ""
      },
      {
        "offset": 2918,
        "insert": ", MiUserMemo",
        "previous": ""
      },
      {
        "offset": 3469,
        "insert": ", MiUserMemo",
        "previous": ""
      }
    ]
  },
  "packages/backend-upstream/upstream-sync.json": {
    "currentSha256": "2249ddafc88912805a900366e8ee19cebf5f4f584ac28a932c2ab26a44282661",
    "previousSha256": "321ffe253df336975cc763aacb04f8f5a2286c1d4e85a76285b74b58373429dd",
    "patches": [
      {
        "offset": 1232,
        "insert": ",\n\t\t\"src/models/UserMemo.ts\"",
        "previous": ""
      }
    ]
  },
  "packages/backend-next/test/package-imports.test.ts": {
    "currentSha256": "6d892d5b6f571cf93fea57c80c5346a9f63fd15b6e8c018b7c60b44886367b2f",
    "previousSha256": "6cbf1b616b51d139298dc85350137a10c430a89205467cf454ba8b101de68d90",
    "patches": [
      {
        "offset": 297,
        "insert": ", MiUserMemo",
        "previous": ""
      },
      {
        "offset": 3151,
        "insert": "const memoMetadata = source.getMetadata(MiUserMemo);\n\texpect(memoMetadata.tableName).toBe('user_memo');\n\texpect(memoMetadata.indices.some(index => index.isUnique && index.columns.map(column => column.propertyName).join(',') === 'userId,targetUserId')).toBe(true);\n\tfor (const property of ['user', 'targetUser']) {\n\t\tconst relation = memoMetadata.relations.find(value => value.propertyName === property);\n\t\texpect(relation?.inverseEntityMetadata.tableName).toBe('user');\n\t\texpect(relation?.onDelete).toBe('CASCADE');\n\t}\n\t",
        "previous": ""
      },
      {
        "offset": 3716,
        "insert": "9",
        "previous": "8"
      }
    ]
  }
};
export function projectUserMemoEntityInput(path, actual, driftLabel = 'package import measured input') {
 actual = projectPageLikeEntityInput(path, actual, driftLabel);
 const binding = Object.hasOwn(userMemoEntityProjection, path) ? userMemoEntityProjection[path] : undefined;
 if (!binding) return actual;
 if (sha(actual) === binding.previousSha256) return actual;
 assert.equal(sha(actual), binding.currentSha256, `${driftLabel} (user memo): ${path}`);
 let before = Buffer.from(actual);
 for (const patch of [...binding.patches].reverse()) {
  const insert = Buffer.from(patch.insert);
  assert.deepEqual(before.subarray(patch.offset, patch.offset + insert.length), insert, 'user memo Entity exact predecessor anchor');
  before = Buffer.concat([before.subarray(0, patch.offset), Buffer.from(patch.previous), before.subarray(patch.offset + insert.length)]);
 }
 assert.equal(sha(before), binding.previousSha256, 'user memo Entity exact predecessor identity');
 return before;
}

// #293 adds PageLike and verifies its registered metadata. Restore precisely
// these measured bytes before applying the earlier UserMemo transition.
const pageLikeEntityProjection = {
  "packages/backend-upstream/.managed-files.json": {
    "currentSha256": "1dbc03fe89be48dbb79fd54f30b91490a82a50225da516e40c28cdc67dce565e",
    "previousSha256": "48bbbdcd10e4b90e03622a94ecb9539819963cecb7acaffa6ef9d24979c41410",
    "patches": [
      {
        "offset": 17423,
        "insert": "ageLike.ts\",\n\t\"src/models/P",
        "previous": ""
      }
    ]
  },
  "packages/backend-upstream/exports/entities.ts": {
    "currentSha256": "3f189c5ebff793a377034680a6a7d1694f56ee24c185c91ab84fc8769cc2188d",
    "previousSha256": "05ff04e21dee5f38a108332c5c1e9bbdee734e8e8b8169f363674a39050e9146",
    "patches": [
      {
        "offset": 2399,
        "insert": "import { MiPageLike } from '../src/models/PageLike.js';\n",
        "previous": ""
      },
      {
        "offset": 2986,
        "insert": ", MiPageLike",
        "previous": ""
      },
      {
        "offset": 3549,
        "insert": ", MiPageLike",
        "previous": ""
      }
    ]
  },
  "packages/backend-upstream/upstream-sync.json": {
    "currentSha256": "9f9398d372fba9e781f71f9782fae16d63268f8488956f8d788bd618240dd484",
    "previousSha256": "2249ddafc88912805a900366e8ee19cebf5f4f584ac28a932c2ab26a44282661",
    "patches": [
      {
        "offset": 1260,
        "insert": ",\n\t\t\"src/models/PageLike.ts\"",
        "previous": ""
      }
    ]
  },
  "packages/backend-next/test/package-imports.test.ts": {
    "currentSha256": "ec087b0dfa5203ab1652b23f798978a759d077a8b0155deeb23b02df001819db",
    "previousSha256": "6d892d5b6f571cf93fea57c80c5346a9f63fd15b6e8c018b7c60b44886367b2f",
    "patches": [
      {
        "offset": 327,
        "insert": ", MiPageLike",
        "previous": ""
      },
      {
        "offset": 3683,
        "insert": "const pageLike = source.getMetadata(MiPageLike);\n\texpect(pageLike.tableName).toBe('page_like');\n\texpect(pageLike.indices.some(index => index.isUnique && index.columns.map(column => column.propertyName).join(',') === 'userId,pageId')).toBe(true);\n\tfor (const [property, table] of [['user', 'user'], ['page', 'page']] as const) {\n\t\tconst relation = pageLike.relations.find(value => value.propertyName === property);\n\t\texpect(relation?.inverseEntityMetadata.tableName).toBe(table);\n\t\texpect(relation?.onDelete).toBe('CASCADE');\n\t}\n\t",
        "previous": ""
      },
      {
        "offset": 4256,
        "insert": "40",
        "previous": "39"
      }
    ]
  }
};
export function projectPageLikeEntityInput(path, actual, driftLabel = 'package import measured input') {
 const binding = Object.hasOwn(pageLikeEntityProjection, path) ? pageLikeEntityProjection[path] : undefined;
 if (!binding || [binding.previousSha256, userMemoEntityProjection[path]?.previousSha256].includes(sha(actual))) return actual;
 assert.equal(sha(actual), binding.currentSha256, `${driftLabel} (PageLike): ${path}`);
 let before = Buffer.from(actual);
 for (const patch of [...binding.patches].reverse()) {
  const insert = Buffer.from(patch.insert);
  assert.deepEqual(before.subarray(patch.offset, patch.offset + insert.length), insert, 'PageLike exact predecessor anchor');
  before = Buffer.concat([before.subarray(0, patch.offset), Buffer.from(patch.previous), before.subarray(patch.offset + insert.length)]);
 }
 assert.equal(sha(before), binding.previousSha256, 'PageLike exact predecessor identity');
 return before;
}
