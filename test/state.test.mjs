import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

import { createCollector } from '../lib/state.js';
import { apply as applyPlugin } from '../lib/index.js';
import { createMockCtx, settle } from './mock-ctx.mjs';

const SNAPSHOT_KEYS = [
	'schema',
	'generatedAt',
	'status',
	'host',
	'counts',
	'stations',
	'alerts',
	'cards',
	'activity',
	'vitals',
	'notes',
];

const STATION_ORDER = ['needs-you', 'running', 'sessions', 'jobs', 'subagents', 'goals', 'context', 'errors'];

async function collectorFor(overrides) {
	const mock = createMockCtx(overrides);
	const collector = createCollector(mock.ctx);
	await settle(6);
	return { mock, collector };
}

/* ── the JSON contract ──────────────────────────────────────────────────── */

test('snapshot is a complete, self-consistent document', async () => {
	const { collector } = await collectorFor();
	const snap = collector.snapshot();

	for (const key of SNAPSHOT_KEYS) {
		assert.ok(key in snap, `missing top-level key: ${key}`);
	}
	assert.equal(snap.schema, 1);
	assert.ok(Number.isFinite(snap.generatedAt));
	assert.ok(['ok', 'warn', 'alert'].includes(snap.status));
	assert.ok(Array.isArray(snap.alerts));
	assert.ok(Array.isArray(snap.cards));
	assert.ok(Array.isArray(snap.activity));
	assert.ok(Array.isArray(snap.notes));
	assert.ok(snap.notes.length <= 6, 'notes must stay short enough for a wall board');

	for (const [key, value] of Object.entries(snap.counts)) {
		assert.equal(typeof value, 'number', `counts.${key} must be a number, got ${typeof value}`);
		assert.ok(Number.isFinite(value) && value >= 0, `counts.${key} must be a non-negative number`);
	}

	assert.equal(snap.counts.liveSessions, 3);
	assert.equal(snap.counts.agentsRunning, 1);
	assert.equal(snap.counts.agentsIdle, 2);
	assert.equal(snap.counts.jobsRunning, 1);
	// failed (2min ago) + killed (20min ago): both inside the 2h job alert
	// window, and the queue shows both — the counter must match the queue.
	assert.equal(snap.counts.jobsFailed, 2);
	assert.equal(snap.counts.subagentsRunning, 1);
	assert.equal(snap.counts.pendingApprovals, 1);
	assert.equal(snap.counts.goalsActive, 1);
	assert.equal(snap.counts.goalsBlocked, 1);
	assert.equal(snap.counts.sessionsTotal, 3);

	collector.dispose();
});

test('the eight stations are always present in the documented order', async () => {
	const { collector } = await collectorFor();
	const snap = collector.snapshot();

	assert.equal(snap.stations.length, 8);
	assert.deepEqual(
		snap.stations.map((s) => s.id),
		STATION_ORDER,
	);

	for (const station of snap.stations) {
		assert.equal(typeof station.label, 'string');
		assert.ok(station.label.length > 0);
		assert.ok('value' in station, `${station.id} needs a value`);
		assert.equal(typeof station.hint, 'string');
		assert.ok(['ok', 'warn', 'alert'].includes(station.severity), `${station.id} severity`);
	}

	const byId = new Map(snap.stations.map((s) => [s.id, s]));
	assert.equal(byId.get('needs-you').severity, 'alert', 'a pending approval must light the needs-you station');
	assert.equal(byId.get('goals').severity, 'warn', 'a blocked goal is a warning, not an alarm');
	assert.equal(byId.get('errors').severity, 'alert');
	assert.equal(byId.get('context').suffix, '%');
	// worst live context use is 214_000 / 262_144 = 82%
	assert.equal(byId.get('context').value, 82);
	assert.equal(byId.get('context').severity, 'warn');

	collector.dispose();
});

test('status is the worst station severity', async () => {
	const { collector } = await collectorFor();
	assert.equal(collector.snapshot().status, 'alert', 'a pending approval plus a failed job is an alarm');

	// No approvals, no failed jobs, no blocked goals → a quiet line.
	const quiet = await collectorFor({
		sessions: { list: () => [] },
		agents: { list: () => [], roots: () => [] },
		goals: { get: () => null },
		jobs: { list: () => [], onJobsChanged: () => () => {} },
		subagents: { listChildren: async () => [] },
		agentTeams: { remoteView: async () => ({ tasks: [] }) },
	});
	assert.equal(quiet.collector.snapshot().status, 'ok');
	assert.equal(quiet.collector.snapshot().alerts.length, 0);

	collector.dispose();
	quiet.collector.dispose();
});

test('context pressure alone drives the board colour, 75% is 注意 and 90% is 異常', async () => {
	// The whole product is one colour. The 75% line is the only way the board
	// turns yellow, so both thresholds are worth pinning: a boundary that drifts
	// silently turns a warning into a calm green wall nobody looks at.
	const collect = async (tokens) => {
		const { collector } = await collectorFor({
			sessionProjections: {
				stateOf: (session, key) =>
					key === 'contextPressure' ? { projectedTokens: tokens, contextWindow: 262144 } : undefined,
			},
		});
		const snap = collector.snapshot();
		collector.dispose();
		return snap;
	};

	const warn = await collect(216_000); // 82%
	assert.equal(warn.stations.find((s) => s.id === 'context').severity, 'warn');
	assert.equal(warn.stations.find((s) => s.id === 'context').value, 82);

	const alert = await collect(249_000); // 95%
	assert.equal(alert.stations.find((s) => s.id === 'context').severity, 'alert');
	assert.equal(alert.status, 'alert', 'a single station at alert lifts the whole board');
});

/* ── approvals are folded out of the session log ────────────────────────── */

test('pending approvals are derived by folding the log backwards', async () => {
	const { collector } = await collectorFor();
	const snap = collector.snapshot();

	assert.equal(snap.alerts.length, 4, 'approval + blocked goal + failed job + killed job');
	assert.deepEqual(
		snap.alerts.map((a) => a.id).sort(),
		['approval:ap_1', 'goal-blocked:goal-bridge', 'job:job_2', 'job:job_5'].sort(),
	);
	const approval = snap.alerts.find((a) => a.kind === 'approval');
	assert.ok(approval, 'the open approval must surface');
	assert.equal(approval.severity, 'alert');
	assert.match(approval.title, /bash/);
	assert.equal(approval.detail, 'pnpm install を実行します');
	assert.equal(approval.sessionId, 'ses_andon0001');
	assert.match(approval.sessionTitle, /アンドン/);

	// ap_old was asked before it was decided; the fold must not resurrect it.
	assert.equal(snap.alerts.filter((a) => a.kind === 'approval').length, 1);

	collector.dispose();
});

test('a decision event clears the approval it belongs to', async () => {
	const { mock, collector } = await collectorFor();
	assert.equal(collector.snapshot().counts.pendingApprovals, 1);

	mock.emit('session/event', mock.sessions[0], {
		type: 'approval/decided',
		seq: 99,
		time: Date.now(),
		data: { id: 'ap_1', outcome: 'rejected' },
	});

	const snap = collector.snapshot();
	assert.equal(snap.counts.pendingApprovals, 0);
	assert.equal(snap.alerts.filter((a) => a.kind === 'approval').length, 0);
	assert.match(snap.activity[0].text, /承認 拒否/);
	assert.equal(snap.activity[0].severity, 'warn');
	assert.ok(snap.activity[0].at > 0);

	collector.dispose();
});

/* ── activity ring ─────────────────────────────────────────────────────── */

test('activity is newest-first, bounded, and never empty of signal', async () => {
	const { mock, collector } = await collectorFor();
	const before = collector.snapshot().activity.length;
	assert.ok(before > 0);

	for (let i = 0; i < 80; i += 1) {
		// `workspace/changes` renders `変更 Nファイル`, so each push is a distinct
		// line. Pushing one identical event 80 times would exercise the repeat
		// fold (pushActivity) instead of the ring bound this test is about.
		mock.emit('session/event', mock.sessions[0], {
			type: 'workspace/changes',
			seq: 100 + i,
			time: Date.now() + i,
			data: { total: i + 1 },
		});
	}
	const activity = collector.snapshot().activity;
	assert.equal(activity.length, 40, 'the ring must stay bounded at 40 lines');
	assert.ok(activity[0].at >= activity[activity.length - 1].at, 'newest first');
	for (const line of activity) {
		assert.equal(typeof line.text, 'string');
		assert.ok(line.text.length <= 120);
		assert.ok(['ok', 'warn', 'alert'].includes(line.severity));
		assert.ok(line.count >= 1, 'every line carries a repeat count');
	}

	// And the fold itself: the same event repeated inside the window is one line.
	// The ring is already full here, so folding must not grow it past the bound.
	// (`assistant/message` is not recorded at all — it was the event that filled
	// the ticker with identical rows — so this uses 入力, which is recorded.)
	const seen = collector.snapshot().activity.length;
	for (let i = 0; i < 5; i += 1) {
		mock.emit('session/event', mock.sessions[1], {
			type: 'user/message',
			seq: 500 + i,
			time: Date.now() + i,
			data: {},
		});
	}
	const folded = collector.snapshot().activity;
	assert.ok(folded.length <= seen, 'folding never exceeds the ring bound');
	assert.equal(folded[0].text, '入力');
	assert.equal(folded[0].count, 5, 'five identical lines fold into one counted row');

	collector.dispose();
});

test('a job that settles through onJobsChanged becomes an activity line', async () => {
	const mock = createMockCtx();
	const collector = createCollector(mock.ctx);
	await settle(4);

	mock.jobs[0].status = 'completed';
	mock.jobs[0].finishedAt = Date.now();
	mock.emit('jobs/changed');
	await settle(2);

	const snap = collector.snapshot();
	assert.match(snap.activity[0].text, /pnpm install 完了/);
	assert.equal(snap.counts.jobsRunning, 0);

	collector.dispose();
});

/* ── cards ─────────────────────────────────────────────────────────────── */

test('cards land in the right column and only recent work is shown', async () => {
	const { collector } = await collectorFor();
	const snap = collector.snapshot();

	const byId = new Map(snap.cards.map((c) => [c.id, c]));
	assert.equal(byId.get('session:ses_andon0001').column, 'running', 'a running agent with an active goal is running');
	assert.equal(byId.get('session:ses_bridge0002').column, 'alert', 'a blocked goal is the alert column');
	assert.equal(byId.get('session:ses_bridge0002').statusLabel, '遮断');
	assert.equal(byId.get('session:ses_repo000003').column, 'queued', 'a queued message is waiting work');
	assert.equal(byId.get('job:job_1').column, 'running');
	assert.equal(byId.get('job:job_2').column, 'alert');
	assert.equal(byId.get('job:job_3').column, 'done');
	assert.equal(byId.get('job:job_5').column, 'alert', 'a killed job is an alarm while it is recent');
	assert.equal(byId.has('job:job_4'), false, 'work finished five hours ago is not board material');
	assert.equal(byId.get('task:t1').column, 'running');
	assert.equal(byId.get('task:t2').column, 'alert', 'a blocked task cannot be running');
	assert.equal(byId.get('task:t3').column, 'done');

	for (const card of snap.cards) {
		assert.ok(['alert', 'running', 'queued', 'done'].includes(card.column), card.column);
		assert.ok(['ok', 'warn', 'alert'].includes(card.severity));
		assert.equal(typeof card.title, 'string');
		assert.ok(card.title.length > 0, `${card.id} needs a title`);
		assert.ok(card.title.length <= 140);
		assert.ok(Array.isArray(card.metrics) && card.metrics.length <= 3);
		assert.equal(typeof card.detail, 'object');
	}

	collector.dispose();
});

test('a card without its live session is dropped rather than shown empty', async () => {
	const { mock, collector } = await collectorFor();
	// the agent list still claims the session, the session list no longer has it
	mock.sessions.pop();
	const snap = collector.snapshot();
	assert.equal(snap.cards.some((c) => c.id === 'session:ses_repo000003'), false);
	collector.dispose();
});

/* ── degradation: this is the whole point ──────────────────────────────── */

test('every service may be missing or broken without throwing', async () => {
	const boom = () => {
		throw new Error('service exploded');
	};
	const { collector } = await collectorFor({
		sessions: { list: boom },
		agents: { list: boom, roots: boom },
		jobs: { list: boom, onJobsChanged: boom },
		goals: { get: boom },
		sessionProjections: { stateOf: boom },
		sessionQuery: { listSessions: async () => boom() },
		subagents: { listChildren: async () => boom() },
		agentTeams: { remoteView: async () => boom() },
		workspaceRegistry: { list: boom },
	});

	let snap;
	assert.doesNotThrow(() => {
		snap = collector.snapshot();
	});
	assert.equal(snap.schema, 1);
	assert.equal(snap.stations.length, 8);
	assert.equal(snap.cards.length, 0);
	assert.equal(snap.status, 'ok', 'nothing observable means nothing wrong');
	assert.ok(snap.notes.length > 0, 'silence is not the same as health: the notes must say so');

	collector.dispose();
});

test('a snapshot stays fast enough to poll every two seconds', async () => {
	const { collector } = await collectorFor();
	collector.snapshot(); // warm

	const started = process.hrtime.bigint();
	for (let i = 0; i < 200; i += 1) collector.snapshot();
	const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

	assert.ok(elapsedMs < 400, `200 snapshots took ${elapsedMs.toFixed(1)}ms`);
	collector.dispose();
});

test('dispose removes every listener and timer', async () => {
	const mock = createMockCtx();
	const collector = createCollector(mock.ctx);
	await settle(4);

	const before = [...mock.handlers.values()].reduce((n, list) => n + list.length, 0);
	assert.ok(before >= 6, 'the collector subscribes to the harness');

	collector.dispose();
	const after = [...mock.handlers.values()].reduce((n, list) => n + list.length, 0);
	assert.equal(after, 0, 'a disposed collector must leave nothing behind');
});

/* ── the HTTP surface ──────────────────────────────────────────────────── */

function fakeRequest(method = 'GET', url = '/') {
	const req = new EventEmitter();
	req.method = method;
	req.url = url;
	req.headers = { host: '127.0.0.1:3080' };
	return req;
}

function fakeResponse() {
	return {
		status: 0,
		headers: {},
		body: '',
		headersSent: false,
		writeHead(status, headers) {
			this.status = status;
			this.headers = { ...headers };
			this.headersSent = true;
			return this;
		},
		end(chunk) {
			if (chunk !== undefined) this.body += String(chunk);
			this.done = true;
			return this;
		},
	};
}

async function mountPlugin(config) {
	const mock = createMockCtx();
	const routes = new Map();
	const effects = [];
	const ctx = {
		...mock.ctx,
		webServer: {
			port: 3080,
			register: ({ kind, path, handler }) => {
				assert.equal(kind, 'exact', 'every route must be an exact match');
				assert.equal(routes.has(path), false, `duplicate route ${path}`);
				routes.set(path, handler);
				return () => routes.delete(path);
			},
		},
		effect: (setup, label) => {
			assert.equal(typeof setup, 'function');
			assert.ok(typeof label === 'string' && label.length > 0, 'effects must be labelled for teardown logs');
			const dispose = setup();
			if (typeof dispose === 'function') effects.push(dispose);
			return dispose;
		},
	};
	applyPlugin(ctx, config);
	await settle(4);
	return { mock, routes, effects };
}

async function call(handler, url) {
	const res = fakeResponse();
	await handler(fakeRequest('GET', url), res, new URL(url, 'http://127.0.0.1:3080'));
	// Route handlers answer asynchronously (they read files off disk), so wait
	// for a real response rather than a fixed number of microtask turns.
	const deadline = Date.now() + 3000;
	while (!res.headersSent && Date.now() < deadline) {
		await new Promise((resolve) => {
			setTimeout(resolve, 5);
		});
	}
	return res;
}

test('the plugin registers its routes beside the harness', async () => {
	const { mock, routes, effects } = await mountPlugin();

	for (const path of [
		'/andon',
		'/andon/',
		'/kanban',
		'/kanban/',
		'/andon/assets/tokens.css',
		'/andon/assets/md3ex.css',
		'/andon/assets/board.js',
		'/andon/assets/andon.js',
		'/kanban/assets/tokens.css',
		'/kanban/assets/md3ex.css',
		'/kanban/assets/board.js',
		'/kanban/assets/kanban.js',
		'/api/andon/state',
		'/api/andon/health',
	]) {
		assert.ok(routes.has(path), `route not registered: ${path}`);
	}
	assert.equal(routes.size, 14, 'exactly the intended surface — nothing wildcarded');

	const bare = await call(routes.get('/andon'), '/andon');
	assert.equal(bare.status, 302);
	assert.equal(bare.headers.location, '/andon/');
	const kanban = await call(routes.get('/kanban'), '/kanban');
	assert.equal(kanban.headers.location, '/kanban/');

	assert.ok(effects.length >= 13, 'each route plus the collector must be disposable');
	for (const dispose of effects) assert.doesNotThrow(dispose);
});

test('the pages and assets are served from disk with the right types', async () => {
	const { routes } = await mountPlugin();

	const andon = await call(routes.get('/andon/'), '/andon/');
	assert.equal(andon.status, 200);
	assert.match(andon.headers['content-type'], /text\/html/);
	assert.match(andon.body, /<title>/);
	assert.match(andon.body, /\.\/assets\/andon\.js/, 'the page must load its script');

	const css = await call(routes.get('/andon/assets/tokens.css'), '/andon/assets/tokens.css');
	assert.equal(css.status, 200);
	assert.match(css.headers['content-type'], /text\/css/);
	assert.match(css.body, /--font-num/, 'the shared tokens must be in there');

	const js = await call(routes.get('/kanban/assets/kanban.js'), '/kanban/assets/kanban.js');
	assert.equal(js.status, 200);
	assert.match(js.headers['content-type'], /javascript/);
});

test('the state endpoint returns the contract and never throws', async () => {
	const { mock, routes } = await mountPlugin();

	const ok = await call(routes.get('/api/andon/state'), '/api/andon/state');
	assert.equal(ok.status, 200);
	const body = JSON.parse(ok.body);
	assert.equal(body.schema, 1);
	assert.equal(body.stations.length, 8);
	assert.equal(ok.headers['cache-control'], 'no-store');

	// Now make collection itself fail and ask again.
	mock.ctx.sessions.list = () => {
		throw new Error('nope');
	};
	const broken = await call(routes.get('/api/andon/state'), '/api/andon/state');
	assert.equal(broken.status, 200, 'a broken collector is still a 200 with a degraded board');
	const degraded = JSON.parse(broken.body);
	assert.equal(degraded.schema, 1);
	assert.equal(degraded.stations.length, 8);
	assert.equal(degraded.status, 'alert');
	assert.ok(degraded.notes.length > 0);
});

test('health reports whether collection is actually possible', async () => {
	const { routes } = await mountPlugin();
	const res = await call(routes.get('/api/andon/health'), '/api/andon/health');
	assert.equal(res.status, 200);
	const body = JSON.parse(res.body);
	assert.equal(body.ok, true);
	assert.equal(body.schema, 1);
	assert.ok(Number.isFinite(body.collectMs));
});

test('config can move the base path and the LAN listener stays off by default', async () => {
	const { routes } = await mountPlugin({ basePath: '/wall', exposeOnHarness: true });
	assert.ok(routes.has('/wall/'));
	assert.ok(routes.has('/wall/assets/tokens.css'));
	assert.equal(routes.has('/andon/'), false);
});

test('a goal reached only through the projection wrapper still lands in the right column', async () => {
	const { collector } = await collectorFor();
	const snap = collector.snapshot();
	const card = snap.cards.find((c) => c.id === 'session:ses_bridge0002');
	assert.ok(card, 'the session whose goal comes only from the projection has a card');

	// `stateOf(session, 'goal')` returns GoalProjectionState (`{ current, ... }`),
	// not the goal itself. Before the unwrap, `.phase` was undefined, so this card
	// fell through every branch into 待機 while its label still read 実行中 — the
	// board contradicted itself and no test noticed, because the fixture had no
	// `goal` projection at all.
	assert.equal(card.column, 'alert', 'a blocked goal is actionable, not queued');
	assert.equal(card.statusLabel, '遮断');
	assert.equal(card.severity, 'alert');
	assert.match(card.title, /姿勢推定/, 'the wrapper was unwrapped far enough to read the objective');
	assert.ok(card.badges.includes('目標'));

	// The counters and the cards must agree about how many goals exist: the
	// projection path counts too, or the andon and the kanban disagree.
	assert.equal(snap.counts.goalsBlocked, 1);
	assert.equal(snap.counts.goalsActive, 1);
});

test('a running agent with an active goal is 実行中, not 待機', async () => {
	const { collector } = await collectorFor();
	const snap = collector.snapshot();
	const card = snap.cards.find((c) => c.id === 'session:ses_andon0001');
	assert.ok(card);
	assert.equal(card.column, 'running');
	assert.equal(card.statusLabel, '実行中');
	assert.ok(!card.badges.includes('解除済み'), 'an armed goal is not marked disarmed');
});

test('the model line survives the modelSelection wrapper', async () => {
	const { collector } = await collectorFor();
	const snap = collector.snapshot();

	// `modelSelection` is another wrapper (`{ lastUsed, pending }`). Reading
	// `.provider` off it yields nothing, so the header silently loses its model
	// line — the same failure the goal wrapper caused, one field over.
	assert.match(snap.vitals.model, /nvnim/);
	assert.match(snap.cards.find((c) => c.id === 'session:ses_andon0001').detail.model, /nvnim/);
});

test('token totals survive the tokenUsage state wrapper', async () => {
	const { collector } = await collectorFor();
	const snap = collector.snapshot();

	// `stateOf` hands back TokenUsageState `{ totals, last }`; the flat four-bucket
	// shape is the wire view. Reading the flat fields off the state gives zeros,
	// and a board that says トークン 0 while the harness burns millions is worse
	// than one that omits the number.
	assert.ok(snap.vitals.tokens.input > 0, 'input tokens reached the header');
	assert.ok(snap.vitals.tokens.output > 0, 'output tokens reached the header');
	assert.ok(snap.vitals.tokens.cacheRead > 0, 'cache reads reached the header');

	const card = snap.cards.find((c) => c.id === 'session:ses_andon0001');
	assert.ok(
		card.metrics.some((m) => m.label === 'トークン'),
		'the card shows a token metric',
	);
});

test('every asset a page references has a route that serves it', async () => {
	// Adding a stylesheet means touching the explicit route table in lib/index.js
	// AND the preview server's own allowlist. Miss either and the browser gets a
	// 404 that looks exactly like "the CSS does nothing" — which cost real time
	// twice (md3ex.css, then dsh.css). This walks the pages instead of trusting
	// anyone to remember.
	const { routes } = await mountPlugin();
	const pages = ['andon', 'kanban'];

	for (const page of pages) {
		const html = readFileSync(new URL(`../public/${page}.html`, import.meta.url), 'utf8');
		const refs = new Set(
			[...html.matchAll(/\.\/assets\/([a-z0-9-]+\.(?:css|js))/g)].map((m) => m[1]),
		);
		assert.ok(refs.size > 0, `${page}.html references no assets at all — the regex broke`);

		for (const ref of refs) {
			assert.ok(
				routes.has(`/${page}/assets/${ref}`),
				`${page}.html asks for ./assets/${ref} but no route serves it`,
			);
		}
	}
});
