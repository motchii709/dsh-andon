/* dsh-andon — mount two always-on boards onto the harness itself.
 *
 *   GET /andon                     the wall board (status lamps, no interaction)
 *   GET /kanban                    the working board (columns, cards, drawer)
 *   GET /andon/assets/<file>       shared stylesheet + scripts
 *   GET /api/andon/state           the JSON both boards poll
 *   GET /api/andon/health          liveness probe
 *
 * The routes live on `ctx.webServer`, so whatever already reaches the harness
 * (tailnet, tunnel, LAN) reaches the boards. Optionally the same table is also
 * served from a second plain listener on the LAN — see `lan.enabled`.
 *
 * Nothing in the request path is allowed to throw: a broken service costs a
 * `notes[]` entry in the JSON, never a 500 and never a crashed harness.
 */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, join, normalize as normalizePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCollector, BUILD } from './state.js';

const name = 'dsh-andon';
const inject = ['webServer'];

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'public');

const MIME = {
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
};

const DEFAULTS = {
	/** mount the boards on the harness webserver (the recommended path) */
	exposeOnHarness: true,
	/** where the boards live on the webserver */
	basePath: '/andon',
	/** v2 judgement thresholds (docs/CONTRACT-v2.md §1). Empty = the defaults
	 *  documented there; anything here wins over them. */
	rules: {},
	/** second, plain listener for tablets that cannot reach the harness */
	lan: {
		enabled: false,
		host: '0.0.0.0',
		port: 3090,
	},
};

function mergeConfig(config) {
	const input = config && typeof config === 'object' ? config : {};
	return {
		...DEFAULTS,
		...input,
		rules: { ...DEFAULTS.rules, ...(input.rules && typeof input.rules === 'object' ? input.rules : {}) },
		lan: { ...DEFAULTS.lan, ...(input.lan && typeof input.lan === 'object' ? input.lan : {}) },
	};
}

function send(res, status, contentType, body) {
	res.writeHead(status, {
		'content-type': contentType,
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
	});
	res.end(body);
}

function sendJson(res, status, value) {
	send(res, status, 'application/json; charset=utf-8', `${JSON.stringify(value)}\n`);
}

function redirect(res, location) {
	res.writeHead(302, { location, 'cache-control': 'no-store' });
	res.end();
}

/** A degraded-but-valid snapshot. The boards must render *something* even when
 *  the collector itself is broken.
 *
 *  Carries the v2 envelope too: a client that reads only `overall` would
 *  otherwise render a calm grey/normal wall while nothing is being collected at
 *  all. Collection failure is stated as `alarm` with the reason spelled out —
 *  the board is not allowed to look healthy about something it cannot see. */
function degradedSnapshot(note, seq) {
	return {
		v: 2,
		serverTime: Date.now(),
		seq,
		build: BUILD,
		overall: 'alarm',
		reason: '状態を収集できません',
		sessions: [],
		log: [],
		history: [],
		schema: 1,
		generatedAt: Date.now(),
		status: 'alert',
		host: { pid: process.pid, uptimeSec: Math.round(process.uptime()), node: process.versions.node, platform: process.platform },
		counts: {
			liveSessions: 0,
			agentsRunning: 0,
			agentsIdle: 0,
			jobsRunning: 0,
			jobsFailed: 0,
			subagentsRunning: 0,
			pendingApprovals: 0,
			pendingQuestions: 0,
			goalsActive: 0,
			goalsBlocked: 0,
			goalsPaused: 0,
			sessionsTotal: 0,
			needsYou: 0,
			running: 0,
			contextMax: 0,
		},
		stations: [
			{ id: 'needs-you', label: '要対応', value: '—', suffix: '', hint: '—', severity: 'off' },
			{ id: 'running', label: '実行中', value: '—', suffix: '', hint: '—', severity: 'off' },
			{ id: 'sessions', label: 'セッション', value: '—', suffix: '', hint: '—', severity: 'off' },
			{ id: 'jobs', label: 'ジョブ', value: '—', suffix: '', hint: '—', severity: 'off' },
			{ id: 'subagents', label: 'サブ', value: '—', suffix: '', hint: '—', severity: 'off' },
			{ id: 'goals', label: '目標', value: '—', suffix: '', hint: '—', severity: 'off' },
			{ id: 'context', label: '文脈', value: '—', suffix: '', hint: '—', severity: 'off' },
			{ id: 'errors', label: '異常', value: '—', suffix: '', hint: '—', severity: 'off' },
		],
		alerts: [],
		cards: [],
		activity: [],
		vitals: { profile: process.env.DSH_PROFILE ?? 'web', workspace: process.cwd(), model: '', contextPct: 0, contextWindow: 0, contextTokens: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, hostTotalSessions: 0 },
		notes: [note],
	};
}

function apply(ctx, config) {
	const options = mergeConfig(config);
	const log = (level, message) => {
		const line = `[dsh-andon] ${message}`;
		try {
			ctx.logger?.[level]?.(line);
		} catch {
			/* logger is a convenience, never a requirement */
		}
	};

	// The judgement thresholds come from plugin config (`rules`, CONTRACT-v2 §1);
	// the collector merges them over the documented defaults.
	const collector = createCollector(ctx, { rules: options.rules });
	ctx.effect(() => () => collector.dispose(), 'dsh-andon:collector');

	/* ── handlers ──────────────────────────────────────────────────────── */

	async function serveFile(res, file) {
		const path = join(PUBLIC_DIR, normalizePath(file).replace(/^([.]{2}[/\\])+/, ''));
		const body = await readFile(path);
		send(res, 200, MIME[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream', body);
	}

	function page(file) {
		return async (_req, res) => {
			try {
				await serveFile(res, file);
			} catch (error) {
				send(res, 500, 'text/plain; charset=utf-8', `dsh-andon: ${file} を読めません\n${String(error?.message ?? error)}\n`);
			}
		};
	}

	function asset(file) {
		return async (_req, res) => {
			try {
				await serveFile(res, file);
			} catch {
				send(res, 404, 'text/plain; charset=utf-8', `dsh-andon: ${file} が見つかりません\n`);
			}
		};
	}

	/** Snapshots served while collection is broken. `seq` must keep moving or a
	 *  client would read the repeat as a dropped frame and re-fetch in a loop. */
	let degradedSeq = 0;

	function state(_req, res, _url) {
		let body;
		try {
			body = collector.snapshot();
		} catch (error) {
			log('error', `snapshot failed: ${String(error?.stack ?? error)}`);
			degradedSeq += 1;
			body = degradedSnapshot('状態の収集に失敗しました', degradedSeq);
		}
		res.writeHead(200, {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			'access-control-allow-origin': '*',
			'x-content-type-options': 'nosniff',
		});
		res.end(`${JSON.stringify(body)}\n`);
	}

	function health(_req, res) {
		const started = Date.now();
		let ok = false;
		try {
			collector.snapshot();
			ok = true;
		} catch {
			ok = false;
		}
		sendJson(res, ok ? 200 : 503, {
			ok,
			schema: 1,
			generatedAt: Date.now(),
			collectMs: Date.now() - started,
			uptimeSec: Math.round(process.uptime()),
			pid: process.pid,
		});
	}

	function notFound(_req, res, url) {
		send(res, 404, 'text/plain; charset=utf-8', `dsh-andon: ${url?.pathname ?? ''} はありません\n`);
	}

	/** path -> handler. Exact matches only: no prefix rule can accidentally
	 *  shadow a harness route, and a harness route cannot shadow these.
	 *
	 *  Each board is canonical at its trailing-slash URL (`/andon/`) so the
	 *  documents can keep plain relative references (`./assets/tokens.css`) —
	 *  which also means the same files open correctly straight off disk during
	 *  development. The bare path redirects. */
	function buildTable() {
		const base = options.basePath.replace(/\/+$/u, '') || '/andon';
		const boards = [base, '/kanban'];
		const rows = [
			[base, (_req, res) => redirect(res, `${base}/`)],
			[`${base}/`, page('andon.html')],
			['/kanban', (_req, res) => redirect(res, '/kanban/')],
			['/kanban/', page('kanban.html')],
			[`${base}/assets/andon.js`, asset('andon.js')],
			['/kanban/assets/kanban.js', asset('kanban.js')],
			['/api/andon/state', state],
			['/api/andon/health', health],
		];
		for (const dir of boards) {
			rows.push([`${dir}/assets/tokens.css`, asset('tokens.css')]);
			rows.push([`${dir}/assets/md3ex.css`, asset('md3ex.css')]);
			rows.push([`${dir}/assets/board.js`, asset('board.js')]);
		}
		return new Map(rows);
	}

	const table = buildTable();
	const homePath = `${options.basePath.replace(/\/+$/u, '') || '/andon'}/`;

	/* ── the same table, reachable without the harness webserver ───────── */

	function lanHandler(req, res) {
		let url;
		try {
			url = new URL(req.url ?? '/', 'http://localhost');
		} catch {
			send(res, 400, 'text/plain; charset=utf-8', 'bad request\n');
			return;
		}
		const handler = table.get(url.pathname) ?? (url.pathname === '/' ? (_req, res) => redirect(res, homePath) : notFound);
		Promise.resolve()
			.then(() => handler(req, res, url))
			.catch((error) => {
				log('error', `lan handler failed for ${url.pathname}: ${String(error?.stack ?? error)}`);
				if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'internal error\n');
			});
	}

	function lanUrls(port) {
		const urls = [`http://127.0.0.1:${port}${homePath}`];
		try {
			for (const [iface, addresses] of Object.entries(networkInterfaces())) {
				for (const address of addresses ?? []) {
					if (address.family !== 'IPv4' || address.internal) continue;
					urls.push(`http://${address.address}:${port}${homePath} (${iface})`);
				}
			}
		} catch {
			/* no interfaces is not a failure */
		}
		return urls;
	}

	let lanServer = null;
	if (options.lan.enabled) {
		lanServer = createServer(lanHandler);
		lanServer.on('error', (error) => {
			log('warn', `LAN 待受を開始できません (${options.lan.host}:${options.lan.port}): ${String(error?.message ?? error)}`);
			lanServer = null;
		});
		lanServer.listen(options.lan.port, options.lan.host, () => {
			for (const url of lanUrls(options.lan.port)) log('info', `LAN ボード: ${url}`);
		});
		ctx.effect(
			() => () => {
				lanServer?.close();
				lanServer = null;
			},
			'dsh-andon:lan-listener',
		);
	}

	/* ── mount on the harness webserver ────────────────────────────────── */

	let mounted = 0;
	if (options.exposeOnHarness) {
		for (const [path, handler] of table) {
			try {
				const dispose = ctx.webServer.register({
					kind: 'exact',
					path,
					handler: (req, res) => {
						Promise.resolve()
							.then(() => handler(req, res, new URL(req.url ?? path, 'http://localhost')))
							.catch((error) => {
								log('error', `handler failed for ${path}: ${String(error?.stack ?? error)}`);
								if (!res.headersSent) {
									send(res, 500, 'text/plain; charset=utf-8', 'internal error\n');
								}
							});
					},
				});
				if (typeof dispose === 'function') ctx.effect(() => dispose, `dsh-andon:route:${path}`);
				mounted += 1;
			} catch (error) {
				log('warn', `ルート ${path} を登録できません: ${String(error?.message ?? error)}`);
			}
		}
		try {
			const port = ctx.webServer.port;
			log('info', `ボードを公開しました: http://127.0.0.1:${port}${homePath} (kanban: http://127.0.0.1:${port}/kanban/)`);
		} catch {
			/* port is only used for the log line */
		}
	}

	if (!options.exposeOnHarness && !options.lan.enabled) {
		log('warn', 'exposeOnHarness も lan も無効です。ボードはどこからも見えません。');
	}
	log('info', `ルート ${mounted}本を登録しました`);

	/* tear the collector down when the harness goes away */
	ctx.effect(
		() => () => {
			log('info', 'アンドン/カンバンを停止しました');
		},
		'dsh-andon:bye',
	);
}

export { name, inject, apply };
