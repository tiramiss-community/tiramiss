/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as stream from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(new URL('../../../../packages/backend-next/package.json', import.meta.url));
const ts = require('typescript');
const sharp = require('sharp');
const blurhash = require('blurhash');
const probeImageSize = require('probe-image-size');
const fileType = await import(require.resolve('file-type'));
const { default: isSvg } = await import(require.resolve('is-svg'));
const { sharpBmp } = await import(require.resolve('@misskey-dev/sharp-read-bmp'));
const root = process.env.UPSTREAM_ROOT; assert(root); assert(['--write', '--check'].includes(process.argv[2]));
const pin = '8e07cf085adf7009583d234a208e30436f020e26';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = [];
const globals = { fs, crypto: { createHash }, stream, fileType, isSvg, probeImageSize, sharpBmp, blurhash, sharp, Uint8ClampedArray, FILE_TYPE_BROWSERSAFE: [] };
function source(path) {
 const bytes = fs.readFileSync(`${root}/${path}`);
 assert.deepEqual(bytes, execFileSync('git', ['-C', root, 'show', `${pin}:${path}`]));
 manifest.push({ path, sha256: sha(bytes), gitBlob: execFileSync('git', ['-C', root, 'rev-parse', `${pin}:${path}`]).toString().trim() });
 return ts.createSourceFile(path, bytes.toString(), ts.ScriptTarget.Latest, true);
}
function evaluate(text) { return vm.runInNewContext(ts.transpile(`(${text})`, { target: ts.ScriptTarget.ES2022 }), globals); }
function variable(sf, name) { return sf.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : []).find(n => n.name.getText(sf) === name); }
function methods(sf, name) { return Object.fromEntries(sf.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === name).members.filter(ts.isMethodDeclaration).map(n => [n.name.getText(sf), evaluate(`${n.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''}function${n.asteriskToken ? '*' : ''}(${n.parameters.map(p => p.getText(sf)).join(',')})${n.body.getText(sf)}`)])); }
const fi = source('packages/backend/src/core/FileInfoService.ts');
for (const n of ['TYPE_OCTET_STREAM', 'TYPE_SVG']) globals[n] = evaluate(variable(fi, n).initializer.getText(fi));
const file = methods(fi, 'FileInfoService');
const ip = source('packages/backend/src/core/ImageProcessingService.ts');
for (const n of ['webpDefault', 'avifDefault']) globals[n] = evaluate(variable(ip, n).initializer.getText(ip));
const image = methods(ip, 'ImageProcessingService');
const drive = methods(source('packages/backend/src/core/DriveService.ts'), 'DriveService');
const mime = source('packages/backend/src/misc/is-mime-image.ts');
globals.dictionary = evaluate(variable(mime, 'dictionary').initializer.getText(mime));
globals.isMimeImage = evaluate(variable(mime, 'isMimeImage').initializer.getText(mime));
const corpusBytes = fs.readFileSync(new URL('./fixtures.json', import.meta.url));
const corpus = JSON.parse(corpusBytes);
const logger = { debug() {}, info() {}, warn() {} };
const receiver = { ...file, ...drive, config: {}, registerLogger: logger, imageProcessingService: image };
const normalize = v => JSON.parse(JSON.stringify(v));
async function readImage(image) {
 if (!image) return null;
 const m = await sharp(image.data, { animated: true }).metadata();
 const { data, info } = await sharp(image.data, { animated: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
 let alphaMin = 255, alphaMax = 0;
 for (let i = info.channels - 1; i < data.length; i += info.channels) { alphaMin = Math.min(alphaMin, data[i]); alphaMax = Math.max(alphaMax, data[i]); }
 return normalize({ type: image.type, ext: image.ext, format: m.format, width: m.width, height: m.height, pages: m.pages ?? 1, pageHeight: m.pageHeight ?? m.height, hasAlpha: m.hasAlpha, alphaMin, alphaMax, delay: m.delay, loop: m.loop, orientation: m.orientation, hasMetadata: !!(m.exif || m.iptc || m.xmp || m.tifftagPhotoshop) });
}
const directory = fs.mkdtempSync(join(tmpdir(), 'image-ingest-source-'));
const cases = [];
try {
 for (const f of corpus.fixtures) {
  const path = join(directory, f.id); fs.writeFileSync(path, Buffer.from(f.base64, 'base64'));
  let info;
  try { info = await receiver.getFileInfo(path, { fileName: f.fileName, skipSensitiveDetection: true }); } catch (error) {
   cases.push({ id: f.id, infoError: { name: error.name, message: error.message } });
   continue;
  }
  const alts = [];
  for (const generateWeb of [true, false]) {
   const result = await receiver.generateAlts(path, info.type.mime, generateWeb);
   alts.push({ generateWeb, webpublic: await readImage(result.webpublic), thumbnail: await readImage(result.thumbnail) });
  }
  const conversions = [];
  if (['transparent-png', 'oriented-jpeg', 'animated-gif'].includes(f.id)) for (const format of ['Webp', 'Avif', 'Png']) {
   conversions.push({ format: format.toLowerCase(), expected: await readImage(await image[`convertTo${format}`](path, 5, 4)) });
  }
  cases.push({ id: f.id, info: normalize(info), alts, conversions });
 }
 // Drive's error isolation is tested with actual native failures on valid input.
 const svgPath = join(directory, 'svg');
 const failures = [];
 for (const stage of ['webpublic', 'thumbnail', 'metadata']) {
  const r = { ...receiver, imageProcessingService: { ...image } };
  if (stage === 'webpublic') r.imageProcessingService.convertSharpToPng = img => image.convertSharpToPng(img, 0, 0);
  if (stage === 'thumbnail') r.imageProcessingService.convertSharpToWebp = img => image.convertSharpToWebp(img, 0, 0);
  const result = await r.generateAlts(stage === 'metadata' ? join(directory, 'broken-pixels-png') : svgPath, stage === 'metadata' ? 'image/png' : 'image/svg+xml', true);
  failures.push({ stage, webpublic: await readImage(result.webpublic), thumbnail: await readImage(result.thumbnail) });
 }
 const output = JSON.stringify({ upstreamCommit: pin, manifest, corpusSha256: sha(corpusBytes), versions: sharp.versions, excluded: ['video metadata/frames', 'sensitivity inference', 'unused MIME dictionaries'], cases, failures, mimeClassification: Object.fromEntries(['image/jpeg', 'image/tiff', 'image/png', 'image/gif', 'image/apng', 'image/vnd.mozilla.apng', 'image/webp', 'image/avif', 'image/svg+xml', 'image/x-icon', 'image/bmp', 'image/vnd.microsoft.icon', 'image/vnd.adobe.photoshop', 'application/pdf'].map(m => [m, globals.isMimeImage(m, 'sharp-convertible-image-with-bmp')])) }, null, 2) + '\n';
 const target = new URL('./observations.json', import.meta.url);
 if (process.argv[2] === '--write') fs.writeFileSync(target, output); else assert.equal(fs.readFileSync(target, 'utf8'), output);
 console.log(`image-ingest source: ${cases.length} inputs / ${cases.filter(c => c.info).length * 2} alternate cases / 9 conversions / ${failures.length} native failures ${process.argv[2]} PASS`);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
