/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type InstanceSuspensionState = 'none' | 'manuallySuspended' | 'goneSuspended' | 'autoSuspendedForNotResponding';

/** instance 表の行のうち、配送の判断に使う列。 */
export interface InstanceFacts {
	id: string;
	host: string;
	isNotResponding: boolean;
	notRespondingSinceMs: number | null;
	suspensionState: InstanceSuspensionState;
	softwareName: string | null;
	softwareVersion: string | null;
	infoUpdatedAtMs: number | null;
}

/** instance 表へ書く列。指定した列だけを更新する。 */
export interface InstancePatch {
	infoUpdatedAtMs?: number;
	softwareName?: unknown;
	softwareVersion?: unknown;
	openRegistrations?: unknown;
	maintainerName?: unknown;
	maintainerEmail?: unknown;
	name?: unknown;
	description?: unknown;
	iconUrl?: unknown;
	faviconUrl?: unknown;
	themeColor?: unknown;
	isNotResponding?: boolean;
	notRespondingSinceMs?: number | null;
	suspensionState?: InstanceSuspensionState;
}

const autoSuspendAfterMs = 1000 * 60 * 60 * 24 * 7;

/** 本家 DeliverProcessorService の配送成功時の更新。不通の記録だけを消し、停止状態は戻さない。 */
export function deliverSuccessPatch(instance: InstanceFacts): InstancePatch | null {
	if (!instance.isNotResponding) {
		return null;
	}
	return { isNotResponding: false, notRespondingSinceMs: null };
}

/** 本家 DeliverProcessorService の配送失敗時の更新。更新しない場合は null。 */
export function deliverFailurePatch(instance: InstanceFacts, now: number): InstancePatch | null {
	if (!instance.isNotResponding) {
		return { isNotResponding: true, notRespondingSinceMs: now };
	}
	if (instance.notRespondingSinceMs === null) {
		// 不通の開始時刻の列は後から足されたため、それ以前から不通の行は時刻だけを補う。
		return { notRespondingSinceMs: now };
	}
	if (instance.suspensionState === 'none' && instance.notRespondingSinceMs <= now - autoSuspendAfterMs) {
		return { suspensionState: 'autoSuspendedForNotResponding' };
	}
	return null;
}
