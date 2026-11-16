/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(new URL('../../../../packages/backend-next/package.json', import.meta.url));
const ts = require('typescript');
const sharp = require('sharp');
const FFmpeg = require('fluent-ffmpeg');
const root = process.env.UPSTREAM_ROOT;
assert(root);
assert(['--write', '--check'].includes(process.argv[2]));
const pin = '8e07cf085adf7009583d234a208e30436f020e26';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = [];
const directories = [];
// Native filesystem boundary replacing tmp.dir, with production cleanup enabled.
const globals = { sharp, FFmpeg, createTempDir: async () => {
 const directory = fs.mkdtempSync(join(tmpdir(), 'video-source-281-'));
 directories.push(directory);
 return [directory, () => fs.rmSync(directory, { recursive: true, force: true })];
} };
function source(path) {
 const bytes = fs.readFileSync(`${root}/${path}`);
 assert.deepEqual(bytes, execFileSync('git', ['-C', root, 'show', `${pin}:${path}`]));
 manifest.push({ path, sha256: sha(bytes), gitBlob: execFileSync('git', ['-C', root, 'rev-parse', `${pin}:${path}`]).toString().trim() });
 return ts.createSourceFile(path, bytes.toString(), ts.ScriptTarget.Latest, true);
}
function evaluate(text) { return vm.runInNewContext(ts.transpile(`(${text})`, { target: ts.ScriptTarget.ES2022 }), globals); }
function methods(sf, name) { return Object.fromEntries(sf.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === name).members.filter(ts.isMethodDeclaration).map(n => [n.name.getText(sf), evaluate(`${n.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''}function(${n.parameters.map(p => p.getText(sf)).join(',')})${n.body.getText(sf)}`)])); }
const video = methods(source('packages/backend/src/core/VideoProcessingService.ts'), 'VideoProcessingService');
const imageSource = source('packages/backend/src/core/ImageProcessingService.ts');
const declaration = imageSource.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : []).find(n => n.name.getText(imageSource) === 'webpDefault');
globals.webpDefault = evaluate(declaration.initializer.getText(imageSource));
const image = methods(imageSource, 'ImageProcessingService');
const drive = methods(source('packages/backend/src/core/DriveService.ts'), 'DriveService');
const urlSource = source('packages/backend/src/misc/prelude/url.ts');
for (const name of ['query', 'appendQuery']) {
 const fn = urlSource.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
 globals[name] = evaluate(`function(${fn.parameters.map(p => p.getText(urlSource)).join(',')})${fn.body.getText(urlSource)}`);
}
const fixturesBytes = fs.readFileSync(new URL('fixtures.json', import.meta.url));
const fixtures = JSON.parse(fixturesBytes).fixtures;
async function describe(image) {
 if (!image) return null;
 const metadata = await sharp(image.data).metadata();
 const { data } = await sharp(image.data).resize(1, 1).removeAlpha().raw().toBuffer({ resolveWithObject: true });
 return { type: image.type, ext: image.ext, format: metadata.format, width: metadata.width, height: metadata.height, rgb: [...data], hasMetadata: !!(metadata.exif || metadata.iptc || metadata.xmp) };
}
const receiver = { ...video, config: {}, imageProcessingService: image };
const caller = { ...drive, config: {}, videoProcessingService: receiver, registerLogger: { warn() {} } };
const inputDir = fs.mkdtempSync(join(tmpdir(), 'video-input-source-281-'));
try {
 const cases = [];
 for (const fixture of fixtures) {
  const path = join(inputDir, fixture.id); fs.writeFileSync(path, Buffer.from(fixture.base64, 'base64'));
  let thumbnail = null, rejects = false;
  try { thumbnail = await describe(await receiver.generateVideoThumbnail(path)); } catch { rejects = true; }
  assert(directories.every(d => !fs.existsSync(d)));
  const local = await caller.generateAlts(path, 'video/mp4', true);
  const external = await ({ ...caller, config: { videoThumbnailGenerator: 'https://video.test' } }).generateAlts(path, 'video/mp4', true);
  cases.push({ id: fixture.id, rejects, thumbnail, local: { webpublic: local.webpublic, thumbnail: await describe(local.thumbnail) }, external });
 }
 const configValues = [null, '', 'https://video.test', 'https://video.test/path?token=x', 'https://video.test/path?'];
 const urls = configValues.map(generator => ({ generator, url: ({ ...receiver, config: { videoThumbnailGenerator: generator } }).getExternalVideoThumbnailUrl('https://file.test/a b.mp4?x=1&y=日本#frame') }));
 // A real failing child tests ffmpeg error propagation, distinct from corrupt input.
 const failurePath = join(inputDir, 'fail-ffmpeg');
 fs.writeFileSync(failurePath, '#!/bin/sh\nexit 17\n', { mode: 0o700 });
 FFmpeg.setFfmpegPath(failurePath);
 let processRejects = false;
 try { await receiver.generateVideoThumbnail(join(inputDir, fixtures[0].id)); } catch { processRejects = true; }
 assert(processRejects);
 assert(directories.every(d => !fs.existsSync(d)));
 const output = JSON.stringify({ upstreamCommit: pin, manifest, corpusSha256: sha(fixturesBytes), versions: { fluentFfmpeg: require('fluent-ffmpeg/package.json').version, sharp: sharp.versions.sharp }, cases, urls, processFailure: { rejects: processRejects, cleanup: true }, cleanup: true }, null, 2) + '\n';
 const target = new URL('observations.json', import.meta.url);
 if (process.argv[2] === '--write') fs.writeFileSync(target, output); else assert.equal(fs.readFileSync(target, 'utf8'), output);
 console.log(`video-ingest source: ${cases.length} inputs / local+external branches / ${urls.length} URLs / process failure + cleanup ${process.argv[2]} PASS`);
} finally { fs.rmSync(inputDir, { recursive: true, force: true }); for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true }); }
