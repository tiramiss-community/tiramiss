/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import * as Bull from 'bullmq';
import type { InstancesRepository, UsersRepository } from '@/models/_.js';
import type { MiLocalUser, MiRemoteUser } from '@/models/User.js';
import { DI } from '@/di-symbols.js';
import type { MiMeta } from '@/models/Meta.js';
import { ApDeliverManagerService } from '@/core/activitypub/ApDeliverManagerService.js';
import { RelayService } from '@/core/RelayService.js';
import { FederatedInstanceService } from '@/core/FederatedInstanceService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import NotesChart from '@/core/chart/charts/notes.js';
import PerUserNotesChart from '@/core/chart/charts/per-user-notes.js';
import InstanceChart from '@/core/chart/charts/instance.js';
import { bindThis } from '@/decorators.js';
import { QueueService } from '@/core/QueueService.js';
import type { NoteDeleteJobData } from '@/queue/types.js';
import type Logger from '@/logger.js';
import { QueueLoggerService } from '@/queue/QueueLoggerService.js';

@Injectable()
export class NoteDeleteProcessorService {
	private logger: Logger;

	constructor(
		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.instancesRepository)
		private instancesRepository: InstancesRepository,

		private userEntityService: UserEntityService,
		private apDeliverManagerService: ApDeliverManagerService,
		private relayService: RelayService,
		private federatedInstanceService: FederatedInstanceService,
		private queueService: QueueService,
		private notesChart: NotesChart,
		private perUserNotesChart: PerUserNotesChart,
		private instanceChart: InstanceChart,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('note-delete');
	}

	@bindThis
	public async process(job: Bull.Job<NoteDeleteJobData>): Promise<void> {
		const { noteSnapshot, userSnapshot, apContent, apRecipientIds, quiet, isRemote } = job.data;

		if (!quiet) {
			this.notesChart.update(noteSnapshot as any, false);
			if (this.meta.enableChartsForRemoteUser || !isRemote) {
				this.perUserNotesChart.update(userSnapshot, noteSnapshot as any, false);
			}

			if (this.meta.enableStatsForFederatedInstances && isRemote && userSnapshot.host) {
				this.federatedInstanceService.fetchOrRegister(userSnapshot.host).then(async i => {
					this.instancesRepository.decrement({ id: i.id }, 'notesCount', 1);
					if (this.meta.enableChartsForFederatedInstances) {
						this.instanceChart.updateNote(i.host, noteSnapshot as any, false);
					}
				});
			}

			if (apContent !== null && userSnapshot.uri === null) {
				const localUser = { id: userSnapshot.id, host: null as null };
				const dm = this.apDeliverManagerService.createDeliverManager(localUser as unknown as MiLocalUser, apContent);

				if (apRecipientIds.length > 0) {
					const recipients = await this.usersRepository.findBy({ id: In(apRecipientIds) }) as MiRemoteUser[];
					for (const recipient of recipients) {
						dm.addDirectRecipe(recipient);
					}
				}

				if (['public', 'home', 'followers'].includes(noteSnapshot.visibility)) {
					dm.addFollowersRecipe();
				}
				await this.relayService.deliverToRelays(localUser as unknown as MiLocalUser, apContent);
				await dm.execute();
			}
		}

		this.queueService.updateUserNotesCount(userSnapshot.id);
	}
}
