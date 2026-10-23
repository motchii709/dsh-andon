/* tools/preview.mjs — stand the two boards up outside the harness.
 *
 * Serves the same documents and the same asset paths as the plugin does, but
 * feeds `/api/andon/state` from a snapshot produced by the real collector over
 * a mock context (test/mock-ctx.mjs). That keeps screenshots honest: what the
 * critique loop looks at is genuinely collected data, arranged by the real
 * code path, not a hand-written mock.
 *
 *   node tools/preview.mjs [--port 4173] [--host 127.0.0.1]
 */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCollector } from '../lib/state.js';
import { createMockCtx, settle } from '../test/mock-ctx.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'public');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const PORT = Number(flag('port', '4173'));
const HOST = flag('host', '127.0.0.1');

const MIME = {
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
};

const mock = createMockCtx();
const collector = createCollector(mock.ctx);
await settle(6);

/** Scenario switches for the critique loop: `?scenario=empty|busy|alarm`.
 *  The scenario is chosen on the PAGE url (`/andon/?scenario=empty`) and
 *  remembered here, because the page itself polls the API without params. */
let scenario = 'busy';

/** Rewrite the v2 fields for a scenario.
 *
 *  `overall` and each session's `state` are judged on the server, so patching
 *  only the v1 keys left every scenario looking like 異常 on the new board —
 *  which made 正常 and 注意 impossible to screenshot deterministically. A
 *  scenario has to describe the whole board, not half of it. */
function withState(base, overall, reason, { needsYou = 0 } = {}) {
	const sessions = (base.sessions ?? []).map((session) => ({
		...session,
		state: overall,
		reason: overall === 'normal' ? '' : session.reason || reason,
	}));
	return {
		...base,
		overall,
		reason,
		sessions,
		counts: { ...base.counts, needsYou },
	};
}

function snapshotFor() {
	const now = Date.now();
	if (scenario === 'busy') return collector.snapshot();
	const base = collector.snapshot();
	if (scenario === 'empty') {
		return withState(
			{
				...base,
				status: 'ok',
				counts: Object.fromEntries(Object.keys(base.counts).map((k) => [k, 0])),
				stations: base.stations.map((s) => ({ ...s, value: 0, suffix: s.suffix, hint: '—', severity: 'ok' })),
				alerts: [],
				cards: [],
				activity: [],
				log: [],
				history: [],
				notes: [],
			},
			'normal',
			'',
		);
	}
	if (scenario === 'quiet' || scenario === 'watch') {
		// The state the board actually sits in most of the day: nothing calling,
		// but the harness is working. `quiet` is 正常, `watch` is the same board
		// with one session drifting (無反応 or context 80%+) so the 注意 styling
		// can be seen without waiting for a real stall.
		const overall = scenario === 'quiet' ? 'normal' : 'watch';
		const patched = {
			...base,
			status: overall === 'normal' ? 'ok' : 'warn',
			alerts: [],
			cards: base.cards.filter((card) => card.column !== 'alert'),
			stations: base.stations.map((s) => ({
				...s,
				severity: overall === 'normal' ? 'ok' : s.severity === 'alert' ? 'warn' : s.severity,
				value: s.id === 'needs-you' || s.id === 'jobs' || s.id === 'errors' ? 0 : s.value,
			})),
			// activity is kept on purpose — that is the whole point of the mode.
		};
		const out = withState(
			patched,
			overall,
			overall === 'normal' ? '' : '実行中なのに 6分間 出力がありません',
		);
		if (overall === 'watch' && out.sessions.length > 0) {
			out.sessions = out.sessions.map((s, i) => ({ ...s, state: i === 0 ? 'watch' : 'normal' }));
			out.sessions[0].reason = '無反応 6分';
		}
		return out;
	}
	if (scenario === 'needs-you') {
		return withState({ ...base, status: 'warn', alerts: base.alerts.slice(0, 1) }, 'needs-you', '承認待ち 1件', {
			needsYou: Math.max(1, base.counts?.needsYou ?? 1),
		});
	}
	if (scenario === 'alarm') {
		return withState(
			{
				...base,
				status: 'alert',
				generatedAt: now,
				stations: base.stations.map((s) => ({ ...s, severity: s.id === 'running' ? 'ok' : 'alert', value: s.value })),
			},
			'alarm',
			'承認待ち 6分放置 1件',
			{ needsYou: Math.max(1, base.counts?.needsYou ?? 1) },
		);
	}
	return base;
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
	const path = normalize(url.pathname).replace(/\\/gu, '/');

	const send = (status, type, body) => {
		res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
		res.end(body);
	};

	if (path === '/' ) {
		res.writeHead(302, { location: '/andon/' });
		res.end();
		return;
	}
	if (path === '/andon' || path === '/kanban') {
		res.writeHead(302, { location: `${path}/${url.search}` });
		res.end();
		return;
	}
	if (path === '/andon/' || path === '/kanban/') {
		// An explicit page load without a scenario means the default (busy)
		// state — never the previous shot's scenario, which silently made the
		// next board render empty and look broken.
		scenario = url.searchParams.get('scenario') ?? 'busy';
	}
	if (path === '/api/andon/state') {
		send(200, MIME['.json'], `${JSON.stringify(snapshotFor())}\n`);
		return;
	}

	// Digits are allowed in the asset name (`md3ex.css`): the original
	// [a-z-]+ silently 404'd it, which looked exactly like the stylesheet
	// failing to apply rather than failing to load.
	const match = /^\/(andon|kanban)\/(assets\/[a-z0-9-]+\.(css|js)|index\.html)?$/u.exec(path);
	if (match) {
		const file = match[2]?.startsWith('assets/') ? match[2].slice('assets/'.length) : `${match[1]}.html`;
		try {
			const body = await readFile(join(PUBLIC_DIR, file));
			send(200, MIME[extname(file)] ?? 'application/octet-stream', body);
		} catch {
			send(404, 'text/plain; charset=utf-8', `preview: ${file} not found\n`);
		}
		return;
	}

	send(404, 'text/plain; charset=utf-8', `preview: ${path} not found\n`);
});

server.listen(PORT, HOST, () => {
	console.log(`[dsh-andon preview] http://${HOST}:${PORT}/andon/`);
	console.log(`[dsh-andon preview] http://${HOST}:${PORT}/kanban/`);
	console.log('[dsh-andon preview] ?scenario=empty | quiet | watch | needs-you | busy | alarm');
});
