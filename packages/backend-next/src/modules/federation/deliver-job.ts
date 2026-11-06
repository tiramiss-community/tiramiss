/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { classifyDeliveryFailure, deliverySucceeded } from './delivery-result.js';
import { extractDbHost } from './host.js';
import { deliverFailurePatch, deliverSuccessPatch } from './instance.js';
import { isDeliverSuspendedSoftware, isFederationAllowedUri } from './policy.js';
import type { DeliveryFailure } from './delivery-result.js';
import type { HostRules } from './host.js';
import type { InstanceFacts, InstancePatch } from './instance.js';
import type { FederationPolicy } from './policy.js';
import type { SignedPost } from './signed-post.js';

/** 本家の DeliverJobData。`content` は投入時に JSON にした本文で、送信時に作り直さない。 */
export interface DeliverJob {
	user: { id: string };
	content: string;
	digest: string;
	to: string;
	isSharedInbox: boolean;
}

export interface DeliverOne {
	user: { id: string };
	activity: Record<string, unknown> | null;
	to: string | null;
	isSharedInbox: boolean;
}

/** 1 つの activity をまとめて投入する宛先。本家 QueueService.deliverMany の引数で、Map の反復順が投入の順になる。 */
export interface DeliverBatch {
	user: { id: string };
	activity: Record<string, unknown>;
	/** キーは inbox、値は shared inbox かどうか。 */
	inboxes: Map<string, boolean>;
}

/** 配送ジョブ 1 回の結果。`done` の `result` は本家のジョブの返り値と同じ文字列。 */
export type DeliverJobOutcome = { kind: 'done'; result: string } | DeliveryFailure;

export interface DeliverJobSettings {
	policy: FederationPolicy;
	enableStatsForFederatedInstances: boolean;
}

export interface InstanceLedger {
	fetchInstance(host: string): Promise<InstanceFacts | null>;
	fetchOrRegisterInstance(host: string): Promise<InstanceFacts>;
	updateInstance(id: string, patch: InstancePatch): Promise<void>;
	/** 停止中の instance の host。本家と同じく 1 時間まで古い一覧でよい。 */
	listSuspendedHosts(): Promise<readonly string[]>;
}

/**
 * 本家 DeliverProcessorService.process。チャートと成功時の fetchInstanceMetadata はまだ移植しない。
 * instance の更新は本家と同じくジョブの結果を待たせない。idle() で開始済みの更新の完了を待てる。
 */
export function createDeliverJobProcessor(ports: {
	readSettings(): Promise<DeliverJobSettings>;
	hostRules: HostRules;
	ledger: InstanceLedger;
	signedPost: SignedPost;
	currentTime(): number;
	/** 待たない instance の更新が失敗したときに呼ぶ。 */
	reportLedgerFailure(error: unknown, context: { to: string }): void;
}) {
	const { ledger } = ports;
	const pending = new Set<Promise<void>>();

	const inBackground = (to: string, work: () => Promise<void>) => {
		const running = work().catch((error: unknown) => {
			ports.reportLedgerFailure(error, { to });
		});
		pending.add(running);
		void running.then(() => pending.delete(running));
	};

	async function process(job: DeliverJob): Promise<DeliverJobOutcome> {
		// 本家と同じく、ポート付きの host は DB 用の host が '' になる。
		const host = new URL(job.to).host;
		const { policy, enableStatsForFederatedInstances } = await ports.readSettings();

		if (!isFederationAllowedUri(policy, ports.hostRules, job.to)) {
			return { kind: 'done', result: 'skip (blocked)' };
		}
		if ((await ledger.listSuspendedHosts()).includes(extractDbHost(job.to))) {
			return { kind: 'done', result: 'skip (suspended)' };
		}
		const instance = enableStatsForFederatedInstances ? await ledger.fetchOrRegisterInstance(host) : await ledger.fetchInstance(host);
		if (instance !== null && isDeliverSuspendedSoftware(policy, instance)) {
			return { kind: 'done', result: 'skip (software suspended)' };
		}

		try {
			await ports.signedPost(job.user, job.to, job.content, job.digest);
		} catch (error) {
			const failure = classifyDeliveryFailure(job, error);
			const now = ports.currentTime();
			// 本家は不通の記録と goneSuspended を並行に書き、未登録の host では初回登録の競合で後者を失うことがある。
			// 順に書けば登録済みの host と同じく両方が残るため、ここでは並行にしない。
			inBackground(job.to, async () => {
				const failed = await ledger.fetchOrRegisterInstance(host);
				const patch = deliverFailurePatch(failed, now);
				if (patch !== null) {
					await ledger.updateInstance(failed.id, patch);
				}
				if (failure.kind === 'stop' && failure.hostGone) {
					const gone = await ledger.fetchOrRegisterInstance(host);
					await ledger.updateInstance(gone.id, { suspensionState: 'goneSuspended' });
				}
			});
			return failure;
		}

		if (instance !== null) {
			const patch = deliverSuccessPatch(instance);
			if (patch !== null) {
				inBackground(job.to, () => ledger.updateInstance(instance.id, patch));
			}
		}
		return { kind: 'done', result: deliverySucceeded };
	}

	return {
		process,
		/** 開始済みの instance の更新がすべて終わるまで待つ。 */
		async idle(): Promise<void> {
			while (pending.size > 0) {
				await Promise.all([...pending]);
			}
		},
	};
}
