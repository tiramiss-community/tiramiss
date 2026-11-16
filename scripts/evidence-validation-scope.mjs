/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

let activeScope;
const currentReaders = new WeakMap();

// A projected reader may declare its original live source. Unknown injected
// functions keep their own identity; no ambient reader can replace them.
export function bindEvidenceCurrentReader(view, current) {
 currentReaders.set(view, getEvidenceCurrentReader(current));
 return view;
}

export function getEvidenceCurrentReader(view) {
 return currentReaders.get(view) ?? view;
}
// Registration only records which observer has already seen a leaf's metadata.
// Validation and requested-path reads still run on every public invocation.
export function registerEvidenceObserver(identity, observer, register) {
 return inEvidenceValidationScope(() => {
  activeScope.observers ??= new Map();
  if (!activeScope.observers.has(identity)) activeScope.observers.set(identity, new WeakSet());
  const registered = activeScope.observers.get(identity);
  if (registered.has(observer)) return;
  registered.add(observer);
  try { register(); } catch (error) { registered.delete(observer); throw error; }
 });
}

const digest = bytes => bytes === null ? null : createHash('sha256').update(bytes).digest('hex');

// Only synchronous work shares a scope. Public calls always start with empty state.
export function inEvidenceValidationScope(run) {
 if (activeScope) return run();
 activeScope = { validations: new Map(), requested: undefined };
 try { return run(); } finally { activeScope = undefined; }
}

export function scopedEvidenceValidation(identity, value, readFile, optional, validate) {
 return inEvidenceValidationScope(() => {
  const scope = activeScope.validations;
  if (!scope.has(identity)) scope.set(identity, new Map());
  const readers = scope.get(identity);
  if (!readers.has(readFile)) readers.set(readFile, new Map());
  const options = readers.get(readFile);
  if (!options.has(optional)) options.set(optional, new Map());
  const records = options.get(optional);
  const metadata = JSON.stringify(value);
  if (records.has(metadata)) {
   const cached = records.get(metadata);
   for (const [path, expected] of cached.files) {
    if (activeScope.requested !== undefined && path !== activeScope.requested && !path.endsWith('.json')) continue;
    assert.equal(digest(readFile(path)), expected, `measured current input drift: ${path}`);
   }
   for (const [path, expected] of cached.artifacts) assert.equal(digest(optional(path)), expected, `actual log/receipt drift: ${path}`);
   return structuredClone(cached.result);
  }
  const files = new Map(), artifacts = new Map();
  const observe = path => {
   const bytes = readFile(path), current = digest(bytes);
   if (files.has(path)) assert.equal(current, files.get(path), `measured current input drift: ${path}`);
   else files.set(path, current);
   return bytes;
  };
  const observeOptional = path => {
   const bytes = optional(path), current = digest(bytes);
   if (artifacts.has(path)) assert.equal(current, artifacts.get(path), `actual log/receipt drift: ${path}`);
   else artifacts.set(path, current);
   return bytes;
  };
  bindEvidenceCurrentReader(observe, readFile);
  const result = validate(observe, observeOptional);
  records.set(metadata, { files, artifacts, result: structuredClone(result) });
  return result;
 });
}

export function withEvidenceRequestedPath(path, run) {
 return inEvidenceValidationScope(() => {
  const scope = activeScope;
  const previous = scope.requested;
  scope.requested = path;
  try { return run(); } finally { scope.requested = previous; }
 });
}
