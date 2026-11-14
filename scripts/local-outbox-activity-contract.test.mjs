/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import test from 'node:test';
import { buildFixture } from '../docs/superpowers/compatibility/remote-user/local-outbox-activity-source-probe.mjs';

const prefix = new URL('../docs/superpowers/compatibility/remote-user/local-outbox-activity-', import.meta.url);
const bytes = suffix => readFileSync(new URL(prefix.href + suffix));
const corpus = JSON.parse(bytes('corpus.json'));
const observed = JSON.parse(bytes('observations.json'));
const sha = value => createHash('sha256').update(value).digest('hex');
const get = id => {
 const row = observed.cases.find(c => c.id === id);
 assert(row, id);
 return row.expected;
};
const ids = id => get(id).body.orderedItems.map(a => a.id.split('/').at(-2));
const nid = n => `at3hjq77note${String(n).padStart(4,'0')}`;
const events = (id, kind) => get(id).events.filter(e => e[0] === kind);

test('finite observations bind to corpus, probe and literal fixed Git blobs', async () => {
 assert.equal(corpus.source, '8e07cf085adf7009583d234a208e30436f020e26');
 assert.equal(observed.source, corpus.source);
 assert.equal(observed.corpusSha256, sha(bytes('corpus.json')));
 assert.equal(observed.probeSha256, sha(bytes('source-probe.mjs')));
 assert.equal(new Set(corpus.cases.map(c => c.id)).size, corpus.cases.length);
 assert.deepEqual(observed.cases.map(c => c.id), corpus.cases.map(c => c.id));
 const paths = new Set();
 for (const entry of observed.manifest) {
  if (paths.has(entry.path)) continue;
  paths.add(entry.path);
  const { stdout } = await promisify(execFile)('git', ['show', `${corpus.source}:${entry.path}`], { encoding:'buffer', maxBuffer:4000000 });
  assert.equal(sha(stdout), entry.sha256, entry.path);
  assert.equal(createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${stdout.length}\0`),stdout])).digest('hex'),entry.gitBlob);
 }
 for (const file of ['ActivityPubServerService','FanoutTimelineEndpointService','FanoutTimelineService','QueryService','ApRendererService']) {
  assert([...paths].some(p => p.endsWith(`/${file}.ts`)),file);
 }
});

test('schema keeps empty bodies, diagnostics and source errors distinct', () => {
 assert.deepEqual(Object.keys(observed).sort(), ['source','dependencies','probeSha256','manifest','corpusSha256','limits','cases'].sort());
 for (const row of observed.cases) {
  assert.deepEqual(Object.keys(row).sort(), ['expected','id']);
  assert.deepEqual(Object.keys(row.expected).sort(), ['body','errors','events','headers','status']);
  assert(!row.expected.errors.some(e => e.name === 'ReferenceError'));
 }
 assert.equal(get('activity-missing').body, '');
 assert.equal(get('activity-announce-missing').errors[0].name, 'Error');
 assert.equal(get('fanout-command-error-no-fallback').errors[0].name, 'TypeError');
});

test('query and HTTP boundaries preserve validation order and matched-route headers', () => {
 for (const id of ['outbox-both-empty','outbox-both','outbox-duplicate-since','outbox-duplicate-until','outbox-invalid-before-user']) {
  assert.equal(get(id).status,400); assert.deepEqual(get(id).events,[]);
 }
 for (const id of ['outbox-duplicate-page','outbox-bracket-page','outbox-false','outbox-one','outbox-upper','outbox-empty-page']) {
  assert.equal(get(id).body.type,'OrderedCollection');
 }
 for (const id of ['outbox-since-empty','outbox-until-empty']) assert.equal(get(id).body.type,'OrderedCollectionPage');
 assert(get('outbox-since-empty').body.id.endsWith('&since_id='));
 assert(get('outbox-until-empty').body.id.endsWith('&until_id='));
 for (const route of ['activity','outbox']) {
  assert.equal(get(route+'-federation-none').status,403);
  assert.deepEqual(get(route+'-federation-none').events,[]);
  assert.equal(get(route+'-accept-html').status,200);
  assert.equal(get(route+'-HEAD').body,'');
  assert(get(route+'-HEAD').events.length > 0);
  assert.equal(get(route+'-OPTIONS').status,404);
  assert.equal(get(route+'-OPTIONS').headers['access-control-allow-origin'],null);
  assert.equal(get(route+'-malformed-before-federation').status,400);
  assert.equal(get(route+'-malformed-before-federation').headers['access-control-allow-origin'],null);
 }
 assert.equal(get('activity-missing').headers.vary,'Accept');
 assert.equal(get('activity-announce-missing').headers['cache-control'],'public, max-age=180');
 assert.equal(get('activity-failure-lookup').headers['cache-control'],null);
 assert.equal(get('outbox-index').headers['cache-control'],'public, max-age=180');
 assert.equal(get('outbox-page').headers['cache-control'],null);
});

test('literal pack/render distinguishes mandatory target from optional quote and context scope', () => {
 assert.equal(get('activity-announce-local').body.type,'Announce');
 assert.equal(get('activity-announce-remote').body.object,'https://remote.test/n/2');
 assert.deepEqual(get('activity-announce-local').events.map(e => e[0]),['root','target']);
 assert.equal(get('activity-announce-missing').status,500);
 assert.equal(get('outbox-announce-missing').status,500);
 for (const id of ['activity-quote-missing','activity-quote-empty-text','activity-quote-empty-cw','activity-quote-reply','activity-quote-files','activity-quote-poll','activity-missing-poll']) {
  assert.equal(get(id).body.type,'Create');
 }
 const body = get('outbox-mixed-activities').body;
 assert(body['@context']);
 assert.deepEqual(body.orderedItems.map(a => a.type),['Create','Announce','Create']);
 for (const a of body.orderedItems) {
  assert.equal(a['@context'],undefined);
  if (typeof a.object === 'object') assert.equal(a.object['@context'],undefined);
 }
});

test('DB boundaries select nearest newer twenty, reverse, retain stored count and both links', () => {
 assert.deepEqual(ids('db-limit-0'),[]);
 for (const id of ['db-limit-1','db-limit-20','db-limit-21']) {
  const b = get(id).body;
  assert.equal(b.totalItems,123); assert(b.prev); assert(b.next);
 }
 assert.equal(ids('db-limit-21').length,20);
 assert.deepEqual(ids('db-since-nearest20-of21'),Array.from({length:20},(_,i) => nid(20-i)));
 assert.deepEqual(events('fanout-index-no-read','redis'),[]);
 assert.deepEqual(events('fanout-index-no-read','db'),[]);
 assert.deepEqual(ids('db-since-exclusive'),Array.from({length:20},(_,i) => nid(21-i)));
 assert.deepEqual(ids('db-until-exclusive'),Array.from({length:19},(_,i) => nid(19-i)));
 assert.equal(ids('outbox-unknown').length,20);
 assert.equal(get('db-limit-0').body.prev,undefined);
 assert.equal(get('db-limit-0').body.next,undefined);
 assert.deepEqual(ids('db-mixed-no-fanout-filters'),[8,7,2,1].map(nid));
});

test('fanout merges/refills literal candidates and preserves fallback and Redis failure distinctions', () => {
 assert.equal(ids('fanout-merge-dedup-limit20').length,20);
 assert.equal(new Set(ids('fanout-merge-dedup-limit20')).size,20);
 assert.equal(events('fanout-multi-batch-refill','hydrate').length,2);
 assert.equal(events('fanout-multi-batch-refill','hydrate')[0][1].clauses[0][1].noteIds.length,22);
 assert.equal(ids('fanout-multi-batch-refill').length,20);
 assert.deepEqual(events('fanout-missing-tail-fallback-cursor','fallback'),[['fallback',nid(18)+'missing',null,18]]);
 assert.deepEqual(events('fanout-null-fallback','fallback'),[['fallback',null,null,20]]);
 assert.deepEqual(events('fanout-since-coverage-fallback','hydrate'),[]);
 assert.deepEqual(events('fanout-empty-since','fallback'),[['fallback',null,'',20]]);
 for (const id of ['fanout-reject-no-fallback','fanout-command-error-no-fallback']) {
  assert.equal(get(id).status,500); assert.deepEqual(events(id,'fallback'),[]); assert.deepEqual(events(id,'db'),[]);
 }
 assert.deepEqual(ids('fanout-mixed-refill'),[5,2,1].map(nid));
 // Rejected cache candidates can reappear through the different DB fallback path.
 assert.deepEqual(ids('fanout-visitor-none-fallback'),[2,1].map(nid));
 assert.deepEqual(ids('fanout-missing-author'),[nid(1)]);
 assert.deepEqual(events('fanout-merge-dedup-limit20','redis')[0][1],[['list:userTimeline:alice',0,-1],['list:userTimelineWithReplies:alice',0,-1]]);
});

test('fixtures cannot contradict the identity-keyed user table', () => {
 for (const rows of Object.values(corpus.datasets)) {
  for (const row of rows) {
   const user = corpus.defaults.users.find(u => u.id === (row.userId ?? corpus.defaults.note.userId));
   if ('user' in row) {
    assert.equal(row.user === null ? null : row.user.isSuspended, user?.isSuspended ?? null, row.id);
   }
  }
 }
});


test('identity joins reject contradictory facts and preserve missing rows', () => {
 for (const c of corpus.cases) {
  const { notes, users } = buildFixture(corpus, c);
  for (const n of notes) {
   assert.equal(n.user, users.find(u => u.id === n.userId) ?? null);
   for (const key of ['reply','renote']) assert.equal(n[key], notes.find(r => r.id === n[key+'Id']) ?? null);
  }
 }
 const fixture = note => buildFixture(corpus, { note });
 assert.throws(() => fixture({ user:{ isSuspended:true } }), /user.isSuspended/);
 assert.throws(() => fixture({ user:null }), /user/);
 assert.throws(() => fixture({ reply:{ user:{ isSuspended:true } } }), /reply/);
 assert.throws(() => fixture({ replyUserId:'invented' }), /replyUserId/);
 assert.throws(() => fixture({ userHost:'remote.test' }), /userHost/);
 assert.throws(() => buildFixture(corpus, { note:{ replyId:nid(2), replyUserId:'remote' }, notes:[{ id:nid(2) }] }), /replyUserId/);
 assert.throws(() => buildFixture(corpus, { note:{ renoteId:nid(2), renote:{ id:nid(3) } }, notes:[{ id:nid(2) }] }), /renote.id/);
 assert.throws(() => buildFixture(corpus, { notes:[{}] }), /duplicate Note/);
 assert.throws(() => buildFixture({ ...corpus, defaults:{ ...corpus.defaults, users:[...corpus.defaults.users,corpus.defaults.users[0]] } }, {}), /duplicate user/);
 const { notes } = buildFixture(corpus, { dataset:'missing-author' });
 assert.equal(notes[1].userId,'absent-author');
 assert.equal(notes[1].user,null);
 assert.equal(notes[0].user.id,'alice');
});

test('existing local replies stay URI references with dive false; remote and missing authors differ', () => {
 assert.equal(get('activity-reply-local').body.object.inReplyTo, `https://local.example/notes/${nid(2)}`);
 assert.equal(get('activity-reply-remote').body.object.inReplyTo,'https://remote.test/n/2');
 assert.equal(Object.hasOwn(get('activity-reply-missing-author').body.object,'inReplyTo'),false);
 for (const [suffix, author] of [['local','alice'],['remote','remote'],['missing-author','absent-author']]) {
  assert.deepEqual(events('activity-reply-'+suffix,'author'),[['author',{ id:author }]]);
 }
});

test('missing-tail cursor skips eligible uncached row above last consumed, not last accepted', () => {
 const id = 'fanout-missing-tail-fallback-cursor';
 const gap = nid(18)+'z';
 assert(gap > nid(18)+'missing' && gap < nid(19));
 assert(corpus.datasets['missing-tail'].some(n => n.id === gap));
 assert.deepEqual(ids(id),[21,19,...Array.from({length:18},(_,i) => 18-i)].map(nid));
 assert(!ids(id).includes(gap));
});

test('pure Announce bypasses malformed mention JSON; successful rendering retains ordered files and public tags', () => {
 assert.equal(get('activity-announce-malformed-mentions').body.type,'Announce');
 assert.deepEqual(get('activity-announce-malformed-mentions').events.map(e => e[0]),['root','target']);
 const n = get('activity-render-media-tags').body.object;
 assert.deepEqual(n.attachment.map(f => [f.name,f.mediaType,f.width,f.height,f.sensitive]),[['two','image/jpeg',30,40,true],['one','image/png',10,20,false]]);
 assert.deepEqual(n.attachment.map(f => f.url),['https://local.example/files/two.jpg','https://local.example/files/one.png']);
 assert.equal(n.sensitive,true);
 assert.deepEqual(n.tag.map(t => [t.type,t.name]),[['Hashtag','#topic'],['Mention','@bob@remote.test'],['Mention','@alice'],['Emoji',':wave:']]);
 assert.deepEqual(n.tag.filter(t => t.type === 'Mention').map(t => t.href),['https://remote.test/users/bob','https://local.example/users/alice']);
 assert.equal(n.tag.at(-1).icon.url,'https://local.example/emoji/wave.png');
 assert.equal(n.tag.at(-1).updated,'2026-11-01T00:00:00.000Z');
 assert(n.cc.includes('https://remote.test/users/bob'));
});

test('HEAD executes page and failures but keeps every response body empty', () => {
 for (const [head, getId] of [['page','outbox-page'],['db-failure','outbox-db-failure'],['user-failure','outbox-failure-lookup'],['lookup-failure','activity-failure-lookup'],['announce-missing','activity-announce-missing'],['federation-none','outbox-federation-none']]) {
  const h = get('HEAD-'+head), g = get(getId);
  assert.equal(h.body,'');
  assert.equal(h.status,g.status);
  assert.deepEqual(h.headers,g.headers);
  assert.deepEqual(h.events,g.events);
  assert.deepEqual(h.errors,g.errors);
 }
});
