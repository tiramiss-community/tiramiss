/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Misskey Entry Point!
 */

import cluster from 'node:cluster';
import { EventEmitter } from 'node:events';
import chalk from 'chalk';
import Xev from 'xev';
import { forkReplacementWorker } from '@/boot/cluster.js';
import Logger from '@/logger.js';
import { envOption } from '../env.js';
import { readyRef } from './ready.js';
import { runLocalShutdown } from './shutdown.js';
import type { Worker } from 'node:cluster';

import 'reflect-metadata';

Error.stackTraceLimit = Infinity;
EventEmitter.defaultMaxListeners = 128;

const logger = new Logger('core', 'cyan');
const clusterLogger = logger.createSubLogger('cluster', 'orange');
const ev = new Xev();

let shuttingDown = false;
let forceExitTimer: NodeJS.Timeout | null = null;

function getShutdownTimeoutMs(): number {
	const raw = process.env.MISSKEY_SHUTDOWN_TIMEOUT_MS;
	if (raw == null) {
		return 20_000;
	}

	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return 20_000;
	}

	return parsed;
}

function waitForWorkersExit(): Promise<void> {
	if (!cluster.isPrimary) {
		return Promise.resolve();
	}

	const workers = Object.values(cluster.workers ?? {}).filter((worker): worker is Worker => worker != null);
	if (workers.length === 0) {
		return Promise.resolve();
	}

	return Promise.all(workers.map(worker => {
		if (worker.isDead()) {
			return Promise.resolve();
		}
		return new Promise<void>(res => worker.once('exit', () => res()));
	})).then(() => undefined);
}

async function beginShutdown(signal: NodeJS.Signals) {
	if (shuttingDown) {
		if (cluster.isPrimary) {
			logger.warn(`Received ${signal} again; forcing exit.`);
			process.exit(signal === 'SIGINT' ? 130 : 143);
		}
		return;
	}

	shuttingDown = true;
	logger.info(`Received ${signal}; shutting down...`);

	const shutdownTimeoutMs = getShutdownTimeoutMs();
	forceExitTimer = setTimeout(() => {
		logger.warn(`Graceful shutdown timed out after ${shutdownTimeoutMs}ms; forcing exit.`);
		process.exit(1);
	}, shutdownTimeoutMs);

	if (forceExitTimer.unref) {
		forceExitTimer.unref();
	}

	if (cluster.isPrimary) {
		for (const worker of Object.values(cluster.workers ?? {})) {
			if (worker == null) {
				continue;
			}
			try {
				worker.process.kill('SIGTERM');
			} catch { }
		}

		try {
			cluster.disconnect(() => {
				logger.info('Cluster disconnected.');
			});
		} catch { }
	}

	await Promise.allSettled([
		runLocalShutdown(signal),
		waitForWorkersExit(),
	]);

	if (forceExitTimer) {
		clearTimeout(forceExitTimer);
		forceExitTimer = null;
	}

	process.exit(0);
}

//#region Events

// Listen new workers
cluster.on('fork', worker => {
	clusterLogger.debug(`Process forked: [${worker.id}]`);
});

// Listen online workers
cluster.on('online', worker => {
	clusterLogger.debug(`Process is now online: [${worker.id}]`);
});

// Listen for dying workers
cluster.on('exit', worker => {
	if (shuttingDown || worker.exitedAfterDisconnect) {
		clusterLogger.info(`Process exited: [${worker.id}]`);
		return;
	}

	// Replace the dead worker,
	// we're not sentimental
	clusterLogger.error(chalk.red(`[${worker.id}] died :(`));
	forkReplacementWorker(worker);
});

process.once('SIGINT', () => void beginShutdown('SIGINT'));
process.once('SIGTERM', () => void beginShutdown('SIGTERM'));

// Display detail of unhandled promise rejection
if (!envOption.quiet) {
	process.on('unhandledRejection', console.dir);
}

// Display detail of uncaught exception
process.on('uncaughtException', err => {
	try {
		logger.error(err);
		console.trace(err);
	} catch { }
});

// Dying away...
process.on('exit', code => {
	logger.info(`The process is going to exit with code ${code}`);
	if (forceExitTimer) clearTimeout(forceExitTimer);
});

//#endregion

if (!envOption.disableClustering) {
	if (cluster.isPrimary) {
		logger.info(`Start main process... pid: ${process.pid}`);
		const { masterMain } = await import('./master.js');
		process.title = 'Misskey (master)';
		await masterMain();
		ev.mount();
	} else if (cluster.isWorker) {
		logger.info(`Start worker process... pid: ${process.pid}`);
		const { workerMain, parseWorkerArguments } = await import('./worker.js');

		const workerArguments = parseWorkerArguments(process.env);
		process.title = `Misskey (worker${workerArguments.__workerName ? `: ${workerArguments.__workerName}` : ''})`;

		await workerMain(workerArguments);
	} else {
		throw new Error('Unknown process type');
	}
} else {
	// 非clusterの場合はMasterのみが起動するため、Workerの処理は行わない(cluster.isWorker === trueの状態でこのブロックに来ることはない)
	logger.info(`Start main process... pid: ${process.pid}`);
	const { masterMain } = await import('./master.js');
	process.title = 'Misskey (master)';
	await masterMain();
	ev.mount();
}

process.on('message', msg => {
	if (msg === 'gc') {
		if (global.gc != null) {
			logger.info('Manual GC triggered');
			global.gc();
			if (process.send != null) process.send('gc ok');
		} else {
			logger.warn('Manual GC requested but gc is not available. Start the process with --expose-gc to enable this feature.');
		}
	}
});

readyRef.value = true;

// ユニットテスト時にMisskeyが子プロセスで起動された時のため
// それ以外のときは process.send は使えないので弾く
if (process.send) {
	process.send('ok');
}
