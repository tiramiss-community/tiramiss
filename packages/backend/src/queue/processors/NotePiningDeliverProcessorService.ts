/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import * as Bull from 'bullmq';
import type { MiLocalUser } from '@/models/User.js';
import { ApDeliverManagerService } from '@/core/activitypub/ApDeliverManagerService.js';
import { RelayService } from '@/core/RelayService.js';
import { bindThis } from '@/decorators.js';
import type { NotePiningDeliverJobData } from '@/queue/types.js';
import type Logger from '@/logger.js';
import { QueueLoggerService } from '@/queue/QueueLoggerService.js';

@Injectable()
export class NotePiningDeliverProcessorService {
	private logger: Logger;

	constructor(
		private apDeliverManagerService: ApDeliverManagerService,
		private relayService: RelayService,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('note-pining-deliver');
	}

	@bindThis
	public async process(job: Bull.Job<NotePiningDeliverJobData>): Promise<void> {
		const { userSnapshot, apContent } = job.data;

		if (apContent == null) return;

		const localUser = { id: userSnapshot.id, host: null as null } as unknown as MiLocalUser;

		await Promise.all([
			this.apDeliverManagerService.deliverToFollowers(localUser, apContent),
			this.relayService.deliverToRelays(localUser, apContent),
		]);
	}
}
