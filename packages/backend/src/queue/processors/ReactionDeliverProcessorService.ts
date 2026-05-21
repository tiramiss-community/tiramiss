/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import * as Bull from 'bullmq';
import type { UsersRepository } from '@/models/_.js';
import type { MiLocalUser, MiRemoteUser } from '@/models/User.js';
import { DI } from '@/di-symbols.js';
import { ApDeliverManagerService } from '@/core/activitypub/ApDeliverManagerService.js';
import { bindThis } from '@/decorators.js';
import type { ReactionDeliverJobData } from '@/queue/types.js';
import type Logger from '@/logger.js';
import { QueueLoggerService } from '@/queue/QueueLoggerService.js';

@Injectable()
export class ReactionDeliverProcessorService {
	private logger: Logger;

	constructor(
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private apDeliverManagerService: ApDeliverManagerService,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('reaction-deliver');
	}

	@bindThis
	public async process(job: Bull.Job<ReactionDeliverJobData>): Promise<void> {
		const { userSnapshot, apContent, apRecipientIds, deliverToFollowers } = job.data;

		if (apContent === null) return;

		const localUser = { id: userSnapshot.id, host: null as null } as unknown as MiLocalUser;
		const dm = this.apDeliverManagerService.createDeliverManager(localUser, apContent);

		if (apRecipientIds.length > 0) {
			const recipients = await this.usersRepository.findBy({ id: In(apRecipientIds) }) as MiRemoteUser[];
			for (const recipient of recipients) {
				dm.addDirectRecipe(recipient);
			}
		}

		if (deliverToFollowers) {
			dm.addFollowersRecipe();
		}

		await dm.execute();
	}
}
