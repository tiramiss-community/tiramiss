/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Bull from 'bullmq';
import type { NotesRepository, UsersRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { UpdateUserNotesCountJobData } from '@/queue/types.js';
import type Logger from '@/logger.js';
import { QueueLoggerService } from '@/queue/QueueLoggerService.js';

@Injectable()
export class UpdateUserNotesCountProcessorService {
	private logger: Logger;

	constructor(
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('update-user-notes-count');
	}

	@bindThis
	public async process(job: Bull.Job<UpdateUserNotesCountJobData>): Promise<void> {
		const { userId } = job.data;

		const count = await this.notesRepository.countBy({ userId });

		await this.usersRepository.update(userId, {
			notesCount: count,
			updatedAt: new Date(),
		});

		this.logger.debug(`updated notesCount for user ${userId}: ${count}`);
	}
}
