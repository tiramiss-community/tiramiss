/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { MiMeta, MiNote, MiUser } from 'backend-upstream/entities';
import { NoteDeleteService } from '@/core/NoteDeleteService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { createTestDatabase } from '../../../../packages/backend-next/test/helpers/database.js';
import { createDataSource } from '../../../../packages/backend-next/src/platform/database/data-source.js';
import { migrateDatabase } from '../../../../packages/backend-next/src/platform/database/migrate.js';
import { createIdCodec } from '../../../../packages/backend-next/src/platform/id-codec.js';
vi.mock('re2', () => ({ default: class {} }));

test('fixed NoteDeleteService with real DELETE trigger preserves its failure boundary', async () => {
 const database = await createTestDatabase();
 let source: ReturnType<typeof createDataSource> | undefined;
 try {
  await migrateDatabase(database.config.database);
  source = await createDataSource(database.config.database).initialize();
  const codec = createIdCodec('aidx');
  const author = { id: codec.newId(Date.now()), username: 'probe_alice', usernameLower: 'probe_alice', host: null, uri: null, isBot: false };
  const moderator = { id: codec.newId(Date.now()) };
  await source.getRepository(MiUser).insert([author, { ...moderator, username: 'moderator', usernameLower: 'moderator' }]);
  await source.getRepository(MiMeta).insert({ id: 'singleton' });
  const parentId = codec.newId(Date.now());
  const targetId = codec.newId(Date.now());
  await source.getRepository(MiNote).insert([
   { id: parentId, userId: author.id, text: 'parent', visibility: 'public', repliesCount: 3 },
   { id: targetId, userId: author.id, text: 'delete', visibility: 'specified', replyId: parentId },
  ]);
  const repository = source.getRepository(MiNote);
  const note = await repository.findOneByOrFail({ id: targetId });
  await source.query(`CREATE FUNCTION reject_delete_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id = '${targetId}' THEN RAISE EXCEPTION 'delete probe failure'; END IF; RETURN OLD; END $$`);
  await source.query('CREATE TRIGGER reject_delete_probe BEFORE DELETE ON note FOR EACH ROW EXECUTE FUNCTION reject_delete_probe()');
  const events: string[] = [];
  const rendering = Object.assign(Object.create(ApRendererService.prototype), {
   config: { url: 'https://local.test' },
   userEntityService: { genLocalUserUri: (id: string) => `https://local.test/users/${id}` },
  });
  const service = new NoteDeleteService(
   { url: 'https://local.test' } as never,
   { enableChartsForRemoteUser: false, enableStatsForFederatedInstances: false } as never,
   source.getRepository(MiUser) as never,
   {
    decrement: async (...args: Parameters<typeof repository.decrement>) => { events.push('decrement'); return repository.decrement(...args); },
    delete: async (...args: Parameters<typeof repository.delete>) => { events.push('delete'); return repository.delete(...args); },
    findOneBy: repository.findOneBy.bind(repository), createQueryBuilder: repository.createQueryBuilder.bind(repository),
   } as never,
   {} as never,
   { isLocalUser: () => true, isRemoteUser: () => false } as never,
   { publishNoteStream: () => { events.push('stream'); } } as never,
   { deliverToRelays: async () => { events.push('relay'); } } as never,
   {} as never,
   rendering,
   { deliverToFollowers: async () => { events.push('followers'); }, deliverToUsers: async () => { events.push('direct'); } } as never,
   { unindexNote: () => { events.push('unindex'); } } as never,
   { log: async () => { events.push('audit'); } } as never,
   { update: () => {} } as never, { update: () => {} } as never, {} as never,
  );
  let failure: unknown;
  try { await service.delete(author as never, note as never, false, moderator as never); } catch (error) { failure = error; }
  // deliverToConcerned is intentionally unawaited by upstream; wait for its observable direct branch.
  await vi.waitFor(() => expect(events).toContain('direct'));
  const actual = {
   upstream: '8e07cf085adf7009583d234a208e30436f020e26',
   failure: failure instanceof Error && failure.message.includes('delete probe failure'),
   targetRemains: await repository.existsBy({ id: targetId }),
   repliesCount: (await repository.findOneByOrFail({ id: parentId })).repliesCount,
   followersStartedBeforeDelete: events.indexOf('followers') < events.indexOf('delete'),
   relayStartedBeforeDelete: events.indexOf('relay') < events.indexOf('delete'),
   directStarted: events.includes('direct'),
   auditStarted: events.includes('audit'),
  };
  const path = new URL('./delete-failure-cases.json', import.meta.url);
  if (process.env.NOTE_DELETE_PROBE_WRITE === '1') {
   writeFileSync(path, JSON.stringify(actual, null, '\t') + '\n');
  } else {
   expect(actual).toEqual(JSON.parse(readFileSync(path, 'utf8')));
  }
 } finally {
  await source?.destroy();
  await database.close();
 }
}, 120000);
