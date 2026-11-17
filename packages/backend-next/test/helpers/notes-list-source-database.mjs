/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as entities from 'backend-upstream/entities';

export async function sourceNotesDatabase(options) {
	const database = new DataSource({ type: 'postgres', ...options, entities: Object.values(entities).filter(value => typeof value === 'function') });
	await database.initialize();
	return { database, notesRepository: database.getRepository(entities.MiNote), usersRepository: database.getRepository(entities.MiUser) };
}
