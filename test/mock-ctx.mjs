/* A fake cordis context carrying the shape of a real, busy harness.
 *
 * Used by both halves of verification:
 *   - test/state.test.mjs asserts the collector against it
 *   - tools/preview.mjs feeds the same snapshot to the real pages, so the
 *     screenshots in the visual-critique loop show genuinely collected data
 *     rather than hand-written mock JSON
 *
 * Every method signature mirrors the installed services; the comments name the
 * file the shape was read from.
 */

const MIN = 60_000;
const NOW = Date.now();

function event(type, seq, minutesAgo, data) {
	return { type, seq, time: NOW - minutesAgo * MIN, data };
}

/** A live session: `header` + a session event log (dsh-session/lib/types). */
function makeSession({ id, cwd, createdAt, events }) {
	const session = {
		header: { id, createdAt, cwd, origin: 'web', delegationDepth: 0 },
		snapshotEvents: () => events,
		eventAt: (seq) => events.find((e) => e.seq === seq),
	};
	return session;
}

export function createMockCtx(overrides = {}) {
	const handlers = new Map();
	const jobHandlers = [];

	const s1 = makeSession({
		id: 'ses_andon0001',
		cwd: 'C:\\Users\\<you>\\Documents\\DSH\\playgrounds\\dsh-andon',
		createdAt: NOW - 41 * MIN,
		events: [
			event('user/message', 1, 41, { text: 'アンドンとカンバンを作って' }),
			event('assistant/message', 2, 40, {}),
			event('approval/asked', 3, 6, { id: 'ap_1', toolName: 'bash', callId: 'c_9', reason: 'pnpm install を実行します' }),
			// asked then decided, in that order, so the backwards fold has to notice
			event('approval/asked', 4, 39, { id: 'ap_old', toolName: 'write', callId: 'c_1' }),
			event('approval/decided', 5, 38, { id: 'ap_old', outcome: 'allowed-once' }),
		],
	});

	const s2 = makeSession({
		id: 'ses_bridge0002',
		cwd: 'C:\\Users\\<you>\\Documents\\DSH\\playgrounds',
		createdAt: NOW - 3 * 60 * MIN,
		events: [
			event('user/message', 1, 170, {}),
			event('assistant/message', 2, 169, {}),
			event('workspace/changes', 3, 20, { total: 3 }),
		],
	});

	const s3 = makeSession({
		id: 'ses_repo000003',
		cwd: 'C:\\Users\\<you>\\Documents\\DSH\\playgrounds',
		createdAt: NOW - 12 * MIN,
		events: [
			event('user/message', 1, 12, {}),
			event('assistant/message', 2, 11, {}),
		],
	});

	const sessions = [s1, s2, s3];

	/** sessionProjections keys verified in dsh-session-projections: title,
	 *  todos, sessionStats, tokenUsage, contextPressure, inbox, modelSelection */
	const projections = new Map([
		[
			'ses_andon0001',
			{
				title: 'アンドン / カンバンの実装と検証',
				todos: [
					{ content: '設計を固める', status: 'completed' },
					{ content: 'CSS トークンを書く', status: 'completed' },
					{ content: 'アンドン画面', status: 'completed' },
					{ content: 'カンバン画面', status: 'completed' },
					{ content: 'コア実装', status: 'in_progress' },
					{ content: 'VLM で見た目を検証', status: 'pending' },
				],
				sessionStats: { turns: 9, steps: 62, openStep: true, pendingCalls: 1 },
				tokenUsage: { totals: { uncachedInputTokens: 184_320, outputTokens: 27_450, cacheReadTokens: 1_204_000, cacheWriteTokens: 96_000 }, last: null },
				contextPressure: { projectedTokens: 141_800, pressureTokens: 138_200, contextWindow: 262_144 },
				inbox: { 'next-turn': [], 'next-step': [{ id: 'q1' }, { id: 'q2' }] },
				// Real shape is { lastUsed, pending } — a wrapper, like goal.
				modelSelection: { lastUsed: { provider: 'nvnim', model: 'deepseek-v4.1-flash' }, pending: null },
			},
		],
		[
			'ses_bridge0002',
			{
				title: null,
				todos: [{ content: 'imu のノイズを平滑化', status: 'pending' }],
				sessionStats: { turns: 34, steps: 210, openStep: false, pendingCalls: 0 },
				tokenUsage: { totals: { uncachedInputTokens: 902_400, outputTokens: 101_200, cacheReadTokens: 4_100_000, cacheWriteTokens: 220_000 }, last: null },
				contextPressure: { projectedTokens: 214_000, pressureTokens: 209_500, contextWindow: 262_144 },
				inbox: { 'next-turn': [], 'next-step': [] },
				// Real shape is { lastUsed, pending } — a wrapper, like goal.
				modelSelection: { lastUsed: { provider: 'nvnim', model: 'deepseek-v4.1-flash' }, pending: null },
				// The projection carries GoalProjectionState — a wrapper — while
				// `ctx.goals.get(agent)` carries the plain Goal. Only the wrapper
				// path is exercised for this session (its entry is absent from the
				// `goals` map below), so a regression in the unwrap shows up as
				// this card falling into the wrong column.
				goal: {
					current: {
						id: 'goal-bridge',
						objective: 'スマホ側の姿勢推定を安定させる',
						phase: 'blocked',
						activation: 'armed',
						blockedReason: { code: 'WAITING_HUMAN', message: '実機のジャイロ値が必要' },
						updatedAt: NOW - 26 * MIN,
					},
					seenGoalIds: ['goal-bridge'],
					failure: null,
				},
			},
		],
		[
			'ses_repo000003',
			{
				title: '古いリポジトリの整理',
				todos: null,
				sessionStats: { turns: 4, steps: 18, openStep: false, pendingCalls: 0 },
				tokenUsage: { totals: { uncachedInputTokens: 44_100, outputTokens: 6_300, cacheReadTokens: 120_000, cacheWriteTokens: 12_000 }, last: null },
				contextPressure: { projectedTokens: 61_200, pressureTokens: 58_900, contextWindow: 262_144 },
				inbox: { 'next-turn': [{ id: 'm1' }], 'next-step': [] },
				// Real shape is { lastUsed, pending } — a wrapper, like goal.
				modelSelection: { lastUsed: { provider: 'nvnim', model: 'deepseek-v4.1-flash' }, pending: null },
			},
		],
	]);

	// The real `Agent` exposes the session it drives as `agent.session`
	// (dsh-agent/lib/types: `readonly session: Session`). There is no
	// `sessionId` field. This fixture used to invent one, so every test passed
	// while the live board built zero cards — the shape below is the contract.
	const agents = [
		{ session: s1, status: 'running' },
		{ session: s2, status: 'idle' },
		{ session: s3, status: 'idle' },
	];

	const goals = new Map([
		[
			'ses_andon0001',
			{
				id: 'goal-andon',
				objective: 'dsh-andon を実装し、見た目の検証を通して GitHub に公開する',
				phase: 'active',
				activation: 'armed',
				updatedAt: NOW - 4 * MIN,
			},
		],
		// `ses_bridge0002` is deliberately absent: its goal reaches the board only
		// through the projection wrapper, which is the case that used to land in
		// the wrong column.
	]);

	const jobs = [
		{ id: 'job_1', kind: 'bash', label: 'pnpm install', status: 'running', startedAt: NOW - 3 * MIN, ownerSession: 'ses_andon0001' },
		{ id: 'job_2', kind: 'bash', label: 'node --test test/state.test.mjs', status: 'failed', startedAt: NOW - 14 * MIN, finishedAt: NOW - 12 * MIN, ownerSession: 'ses_andon0001', detail: 'exit code 1' },
		{ id: 'job_3', kind: 'bash', label: 'msedge --headless --screenshot', status: 'completed', startedAt: NOW - 9 * MIN, finishedAt: NOW - 8 * MIN, ownerSession: 'ses_andon0001' },
		{ id: 'job_4', kind: 'bash', label: 'repomix', status: 'completed', startedAt: NOW - 5 * 60 * MIN, finishedAt: NOW - 5 * 60 * MIN + 40_000, ownerSession: null },
		{ id: 'job_5', kind: 'bash', label: 'pnpm run build', status: 'killed', startedAt: NOW - 22 * MIN, finishedAt: NOW - 20 * MIN, ownerSession: 'ses_repo000003', detail: 'signal SIGTERM' },
	];

	const teamTasks = [
		{ id: 't1', subject: 'lib/state.js を書く', status: 'in_progress', ready: true, owner: 'worker-core', writeScopeWarnings: [], createdAt: NOW - 30 * MIN },
		{ id: 't2', subject: 'VLM でアンドンを酷評させる', status: 'pending', ready: false, blockedBy: ['t1'], owner: null, writeScopeWarnings: [], createdAt: NOW - 29 * MIN },
		{ id: 't3', subject: 'README を書く', status: 'completed', ready: true, owner: 'worker-docs', writeScopeWarnings: [], createdAt: NOW - 28 * MIN },
	];

	const ctx = {
		logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
		on(name, handler) {
			if (!handlers.has(name)) handlers.set(name, []);
			handlers.get(name).push(handler);
			return () => {
				const list = handlers.get(name) ?? [];
				const index = list.indexOf(handler);
				if (index >= 0) list.splice(index, 1);
			};
		},
		sessions: {
			list: () => sessions,
		},
		agents: {
			list: () => agents,
			roots: () => agents,
		},
		goals: {
			get: (agent) => goals.get(agent?.session?.header?.id ?? agent?.sessionId) ?? null,
		},
		sessionProjections: {
			stateOf: (session, key) => projections.get(session?.header?.id)?.[key],
		},
		sessionQuery: {
			listSessions: async () => sessions.map((s) => ({ header: s.header, live: true, persisted: true })),
		},
		subagents: {
			listChildren: async (id) =>
				id === 'ses_andon0001'
					? [
							{ kind: 'child', activity: 'running' },
							{ kind: 'child', activity: 'inactive' },
						]
					: [],
		},
		jobs: {
			list: () => jobs,
			read: (id) => jobs.find((j) => j.id === id),
			onJobsChanged: (handler) => {
				jobHandlers.push(handler);
				return () => {
					const index = jobHandlers.indexOf(handler);
					if (index >= 0) jobHandlers.splice(index, 1);
				};
			},
		},
		agentTeams: {
			remoteView: async (agent) =>
				(agent?.session?.header?.id ?? agent?.sessionId) === 'ses_andon0001'
					? { members: [], tasks: teamTasks }
					: { members: [], tasks: [] },
		},
		workspaceRegistry: {
			list: () => [{ path: 'C:\\Users\\<you>\\Documents\\DSH\\playgrounds', active: true }],
		},
		...overrides,
	};

	return {
		ctx,
		sessions,
		agents,
		jobs,
		goals,
		teamTasks,
		/** deliver a session event the way the harness would */
		emit(name, ...args) {
			for (const handler of handlers.get(name) ?? []) handler(...args);
			if (name === 'jobs/changed') for (const handler of jobHandlers) handler();
		},
		handlers,
	};
}

/** Let the collector's fire-and-forget async refreshes settle. */
export function settle(times = 3) {
	let chain = Promise.resolve();
	for (let i = 0; i < times; i += 1) chain = chain.then(() => new Promise((resolve) => setImmediate(resolve)));
	return chain;
}
