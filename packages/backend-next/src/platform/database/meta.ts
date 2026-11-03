/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiMeta } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { DeliverJobSettings, FederationPolicy } from '../../modules/federation/public.js';

// 本家と同じく、過去の不具合で複数行ある場合はidの大きい行を使い、行がなければid 'x' を作る。
// 作成は呼び出し元の接続で行い、独自のtransactionを開かない。同時に作成されてもupsertの競合で1行に収まる。
export async function readMeta(manager: EntityManager): Promise<MiMeta> {
	const repository = manager.getRepository(MiMeta);
	const [meta] = await repository.find({ order: { id: 'DESC' }, take: 1 });
	if (meta) {
		return meta;
	}

	await repository.upsert({ id: 'x' }, ['id']);
	return await repository.findOneByOrFail({ id: 'x' });
}

export async function readFederationPolicy(manager: EntityManager): Promise<FederationPolicy> {
	return toFederationPolicy(await readMeta(manager));
}

/**
 * 本家 DeliverProcessorService が参照する meta。
 * 本家は更新の通知で保つメモリ上の meta を使う。プロセス間の通知（#217）がまだないため、メモリに持たずジョブごとに読む。
 */
export async function readDeliverJobSettings(manager: EntityManager): Promise<DeliverJobSettings> {
	const meta = await readMeta(manager);
	return { policy: toFederationPolicy(meta), enableStatsForFederatedInstances: meta.enableStatsForFederatedInstances };
}

function toFederationPolicy(meta: MiMeta): FederationPolicy {
	return {
		federation: meta.federation,
		federationHosts: meta.federationHosts,
		blockedHosts: meta.blockedHosts,
		silencedHosts: meta.silencedHosts,
		mediaSilencedHosts: meta.mediaSilencedHosts,
		deliverSuspendedSoftware: meta.deliverSuspendedSoftware.map(x => ({ software: x.software, versionRange: x.versionRange })),
	};
}
