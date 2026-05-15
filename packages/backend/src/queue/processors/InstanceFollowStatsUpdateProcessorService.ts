/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Bull from 'bullmq';
import { DI } from '@/di-symbols.js';
import type { InstancesRepository } from '@/models/_.js';
import { FederatedInstanceService } from '@/core/FederatedInstanceService.js';
import InstanceChart from '@/core/chart/charts/instance.js';
import { bindThis } from '@/decorators.js';
import type Logger from '@/logger.js';
import type { InstanceFollowStatsUpdateJobData } from '@/queue/types.js';
import { QueueLoggerService } from '@/queue/QueueLoggerService.js';

@Injectable()
export class InstanceFollowStatsUpdateProcessorService {
	private logger: Logger;

	constructor(
		@Inject(DI.instancesRepository)
		private instancesRepository: InstancesRepository,

		private federatedInstanceService: FederatedInstanceService,
		private instanceChart: InstanceChart,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('instance-follow-stats-update');
	}

	@bindThis
	public async process(job: Bull.Job<InstanceFollowStatsUpdateJobData>): Promise<void> {
		const { host, direction, isAdditional, updateChart } = job.data;

		const instance = await this.federatedInstanceService.fetchOrRegister(host);

		const column = direction === 'following' ? 'followingCount' : 'followersCount';
		if (isAdditional) {
			await this.instancesRepository.increment({ id: instance.id }, column, 1);
		} else {
			await this.instancesRepository.decrement({ id: instance.id }, column, 1);
		}

		if (updateChart) {
			if (direction === 'following') {
				await this.instanceChart.updateFollowing(instance.host, isAdditional);
			} else {
				await this.instanceChart.updateFollowers(instance.host, isAdditional);
			}
		}
	}
}
