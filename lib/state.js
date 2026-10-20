/* dsh-andon / state.js — collect one JSON snapshot of what the harness is doing.
 *
 * This module knows nothing about HTTP or cordis lifecycle. Given the host
 * `ctx`, `createCollector(ctx).snapshot()` returns exactly the object described
 * in DESIGN.md §5 — synchronously, without throwing, and fast enough to call
 * every two seconds.
 *
 * Nothing here trusts another service. Every read goes through `safe()`, and a
 * failure costs a `notes[]` entry, never a 500.
 *
 * Verified against the installed DSH types:
 *   SessionEvent          = { type, seq, time, data }        dsh-session
 *   TodoItem              = { content, status }              dsh-tool-todo
 *   InboxWireState        = { 'next-turn': [], 'next-step': [] }  dsh-agent
 *   'approval/asked'      data = { id, toolName, callId?, reason? }  dsh-user-approval
 *   'approval/decided'    data = { id, outcome }                     dsh-user-approval
 */

const MAX_ACTIVITY = 40;
const MAX_ALERTS = 20;
const MAX_CARDS = 40;
const DONE_WINDOW_MS = 30 * 60 * 1000;
// Failed/killed jobs stay actionable (and counted) for 2 hours.
const JOB_ALERT_WINDOW_MS = DONE_WINDOW_MS * 4;
const APPROVAL_TTL_MS = 6 * 60 * 60 * 1000;
const SEED_EVENT_LIMIT = 400;
// Identical activity lines inside this window fold into one counted row
// (see pushActivity). 5 min is long enough to collapse a burst of turns and
// short enough that yesterday's identical event never merges into today's.
const REPEAT_WINDOW_MS = 5 * 60 * 1000;

const APPROVAL_OUTCOME = {
	'allowed-once': '許可',
	rejected: '拒否',
	cancelled: '取消',
	unavailable: '応答なし',
};

const STATUS_LABEL = {
	running: '実行中',
	idle: '待機',
	stopping: '停止中',
	completed: '完了',
	killed: '停止',
	failed: '失敗',
	pending: '未着手',
	in_progress: '進行中',
	completed_task: '完了',
};

const STATUS_SEVERITY = {
	failed: 'alert',
	killed: 'alert',
	stopping: 'warn',
	completed: 'ok',
	running: 'ok',
	idle: 'ok',
};

/* ── small helpers ───────────────────────────────────────────────────────── */

function clampText(value, max = 200) {
	if (value === null || value === undefined) return '';
	const flat = String(value).replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function baseName(p) {
	if (typeof p !== 'string' || p === '') return '';
	const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
	return parts[parts.length - 1] || p;
}

function count(value) {
	const n = Number(value);
	return Number.isFinite(n) && n >= 0 ? n : 0;
}

function shortId(id) {
	const s = String(id ?? '');
	return s.length > 10 ? `${s.slice(0, 8)}…` : s || '—';
}

function sevRank(sev) {
	return sev === 'alert' ? 0 : sev === 'warn' ? 1 : 2;
}

/* ── collector ───────────────────────────────────────────────────────────── */

export function createCollector(ctx) {
	const notes = new Set();

	/** Services are resolved lazily and tolerantly.
	 *
	 *  The plugin declares `webServer` as its only hard dependency, so that it
	 *  still loads in a profile that is missing one of the observability
	 *  services. Everything else is looked up through `ctx[name]` (fails when
	 *  not injected) with a `ctx.reflect.get(name, false)` fallback, and a
	 *  negative result is remembered for a few seconds so a missing service
	 *  does not cost a thrown Error on every poll. */
	const MISS_TTL_MS = 5000;
	const serviceCache = new Map();

	function service(name) {
		const hit = serviceCache.get(name);
		if (hit && (hit.value || Date.now() - hit.at < MISS_TTL_MS)) return hit.value;
		let value = null;
		try {
			value = ctx[name] ?? null;
		} catch {
			value = null;
		}
		if (!value) {
			try {
				value = ctx.reflect?.get?.(name, false) ?? null;
			} catch {
				value = null;
			}
		}
		serviceCache.set(name, { value, at: Date.now() });
		return value;
	}

	const svc = new Proxy(
		{},
		{
			get: (_target, name) => (typeof name === 'string' ? service(name) : undefined),
			has: () => true,
		},
	);

	const state = {
		/** approvalId -> { id, toolName, reason, sessionId, since } */
		pending: new Map(),
		/** approvalId -> sessionId, for the decided event which carries no session */
		askedOwner: new Map(),
		/** newest first */
		activity: [],
		/** jobId -> status, to diff into activity lines */
		jobStatus: new Map(),
		questions: 0,
		sessionRecords: null,
		sessionsTotal: 0,
		subagentRunning: 0,
		subagentDiagnostics: 0,
		startupFailures: 0,
		team: { tasks: [], ok: false },
		seenSessions: 0,
	};

	const disposers = [];
	const timers = [];

	function safe(fn, note) {
		try {
			return fn();
		} catch (error) {
			if (note) notes.add(note);
			return undefined;
		}
	}

	function note(text) {
		if (notes.size < 6) notes.add(text);
	}

	/* ── activity ring ─────────────────────────────────────────────────── */

	/** Collapse-and-count. `assistant/message` fires once per turn with no
	 *  distinguishing detail, so on a busy harness the ticker filled up with
	 *  three identical "応答" rows that told the reader nothing. Repeats of the
	 *  same text in the same session inside REPEAT_WINDOW_MS fold into one row
	 *  with `count`, which the UI prints as "応答 ×3". `at` stays at the first
	 *  occurrence so the timestamp marks when the run started, not when it last
	 *  ticked. */
	function pushActivity(text, severity, sessionId, at) {
		const line = clampText(text, 120);
		if (!line) return;
		const when = Number.isFinite(at) ? at : Date.now();
		const sid = sessionId ? String(sessionId) : null;
		const head = state.activity[0];
		if (head && head.text === line && head.sessionId === sid && when - head.at <= REPEAT_WINDOW_MS) {
			head.count += 1;
			return;
		}
		state.activity.unshift({
			at: when,
			severity: severity === 'alert' || severity === 'warn' ? severity : 'ok',
			text: line,
			sessionId: sid,
			count: 1,
		});
		if (state.activity.length > MAX_ACTIVITY) state.activity.length = MAX_ACTIVITY;
	}

	/* ── session events: approvals + activity ──────────────────────────── */

	function onSessionEvent(session, event) {
		if (!event || typeof event !== 'object') return;
		const type = typeof event.type === 'string' ? event.type : event.kind;
		if (!type) return;
		const data = event.data ?? event.payload ?? {};
		const sessionId = session?.header?.id ?? session?.id ?? null;
		const at = Number.isFinite(event.time) ? event.time : Date.now();

		switch (type) {
			case 'approval/asked': {
				const id = String(data.id ?? `${sessionId}:${at}`);
				state.pending.set(id, {
					id,
					toolName: clampText(data.toolName ?? '不明', 40),
					reason: clampText(data.reason ?? '', 120),
					sessionId,
					since: at,
				});
				state.askedOwner.set(id, sessionId);
				pushActivity(`承認待ち: ${clampText(data.toolName ?? '不明', 40)}`, 'alert', sessionId, at);
				return;
			}
			case 'approval/decided': {
				const id = String(data.id ?? '');
				const owner = state.pending.get(id)?.sessionId ?? state.askedOwner.get(id) ?? sessionId;
				state.pending.delete(id);
				state.askedOwner.delete(id);
				const outcome = APPROVAL_OUTCOME[data.outcome] ?? clampText(data.outcome, 20);
				pushActivity(
					`承認 ${outcome}`,
					data.outcome === 'rejected' ? 'warn' : 'ok',
					owner,
					at,
				);
				return;
			}
			case 'user/message':
				pushActivity('入力', 'ok', sessionId, at);
				return;
			case 'assistant/message':
				pushActivity('応答', 'ok', sessionId, at);
				return;
			case 'workspace/changes': {
				const total = count(data.total);
				if (total > 0) pushActivity(`変更 ${total}ファイル`, 'ok', sessionId, at);
				return;
			}
			default:
				// Anything that names a failure is worth a line; everything else
				// (tool results, deltas) would drown the board.
				if (/error|failed|abort/i.test(type)) {
					pushActivity(`${type}`, 'alert', sessionId, at);
				}
		}
	}

	/* ── approvals seeding ─────────────────────────────────────────────── */
	/* There is no enumeration API for pending approvals, so they are derived by
	 * folding the session log. Walk each live session's log BACKWARDS from the
	 * tail: an `asked` whose id we have not already seen decided is pending.
	 * Bounded to the last SEED_EVENT_LIMIT events so a 140k-row session cannot
	 * stall the host.
	 *
	 * `known` is the set of approvals that were already on the board; anything
	 * outside it is genuinely new to this process and gets an activity line so
	 * a wall board does not come up blank after a restart. */

	function seedApprovals(known) {
		const sessions = safe(() => svc.sessions?.list() ?? []);
		if (!sessions) {
			note('承認待ちを復元できません');
			return;
		}
		const decided = new Set();
		for (const session of sessions) {
			const events = safe(() => session?.snapshotEvents?.() ?? []);
			if (!events?.length) continue;
			const slice = events.length > SEED_EVENT_LIMIT ? events.slice(-SEED_EVENT_LIMIT) : events;
			for (let i = slice.length - 1; i >= 0; i -= 1) {
				const event = slice[i];
				const type = event?.type;
				const data = event?.data ?? {};
				if (type === 'approval/decided') {
					decided.add(String(data.id ?? ''));
					continue;
				}
				if (type !== 'approval/asked') continue;
				const id = String(data.id ?? '');
				if (decided.has(id) || state.pending.has(id)) continue;
				const sessionId = session?.header?.id ?? null;
				const at = Number.isFinite(event.time) ? event.time : Date.now();
				const toolName = clampText(data.toolName ?? '不明', 40);
				state.pending.set(id, {
					id,
					toolName,
					reason: clampText(data.reason ?? '', 120),
					sessionId,
					since: at,
				});
				if (!known?.has(id)) pushActivity(`承認待ち: ${toolName}`, 'alert', sessionId, at);
			}
		}
	}

	/* ── jobs: diff into activity ──────────────────────────────────────── */

	function onJobsChanged() {
		const jobs = safe(() => svc.jobs?.list() ?? []);
		if (!jobs) return;
		for (const job of jobs) {
			const previous = state.jobStatus.get(job.id);
			if (previous !== job.status && previous !== undefined) {
				const severity = STATUS_SEVERITY[job.status] ?? 'ok';
				const label = clampText(job.label ?? job.id, 40);
				pushActivity(
					`${label} ${STATUS_LABEL[job.status] ?? job.status}`,
					severity,
					job.ownerSession ?? null,
					job.finishedAt ?? Date.now(),
				);
			}
			state.jobStatus.set(job.id, job.status);
		}
	}

	function seedJobs() {
		const jobs = safe(() => svc.jobs?.list() ?? []);
		if (!jobs) return;
		state.jobStatus.clear();
		for (const job of jobs) state.jobStatus.set(job.id, job.status);
	}

	/* ── subscriptions ─────────────────────────────────────────────────── */

	function subscribe() {
		const on = (name, handler) => {
			const disposer = safe(() => ctx.on(name, handler));
			if (typeof disposer === 'function') disposers.push(disposer);
		};

		on('session/event', onSessionEvent);
		on('session/created', (session) => {
			pushActivity(
				`セッション開始 ${baseName(session?.header?.cwd) || shortId(session?.header?.id)}`,
				'ok',
				session?.header?.id ?? null,
			);
		});
		on('session/disposed', (session) => {
			const id = session?.header?.id;
			for (const [approvalId, entry] of state.pending) {
				if (entry.sessionId === id) state.pending.delete(approvalId);
			}
			pushActivity('セッション終了', 'ok', id ?? null);
		});
		on('agent/status', ({ agent, status }) => {
			if (!agent) return;
			pushActivity(status === 'running' ? '実行開始' : '待機', 'ok', agent.sessionId);
		});
		on('subagent/start', (info) => {
			pushActivity('サブエージェント開始', 'ok', info?.id ?? null);
		});
		on('subagent/end', (info) => {
			const failed = /error|fail|abort/i.test(String(info?.stopReason ?? ''));
			pushActivity(
				`サブエージェント終了${failed ? ` (${clampText(info?.stopReason, 30)})` : ''}`,
				failed ? 'warn' : 'ok',
				info?.id ?? null,
			);
		});
		on('agent-loop/config-start-failed', (payload) => {
			state.startupFailures += 1;
			pushActivity(
				`エージェント起動失敗 (${clampText(payload?.sessionId, 20)})`,
				'alert',
				payload?.sessionId ?? null,
			);
		});

		const jobDisposer = safe(() => svc.jobs?.onJobsChanged?.(onJobsChanged));
		if (typeof jobDisposer === 'function') disposers.push(jobDisposer);
	}

	/* ── background async refreshes ────────────────────────────────────────
	 * Everything `snapshot()` needs is synchronous; the three genuinely async
	 * sources are cached here on timers so a slow query can never make the
	 * board stutter. */

	async function refreshSessionRecords() {
		if (!svc.sessionQuery) {
			note('セッション総数を取得できません');
			return;
		}
		try {
			const records = await svc.sessionQuery.listSessions();
			if (Array.isArray(records)) {
				state.sessionRecords = records;
				state.sessionsTotal = records.length;
			}
		} catch {
			note('セッション総数を取得できません');
		}
	}

	async function refreshSubagents() {
		if (!svc.subagents || !svc.sessions) return;
		let running = 0;
		let diagnostics = 0;
		let any = false;
		const sessions = safe(() => svc.sessions.list() ?? []) ?? [];
		for (const session of sessions.slice(0, 12)) {
			const id = session?.header?.id;
			if (!id) continue;
			try {
				const children = await svc.subagents.listChildren(id);
				any = true;
				for (const child of children ?? []) {
					if (child?.kind === 'diagnostic') diagnostics += 1;
					else if (child?.activity === 'running') running += 1;
				}
			} catch {
				/* one unreadable session must not hide the others */
			}
		}
		if (any) {
			state.subagentRunning = running;
			state.subagentDiagnostics = diagnostics;
		}
	}

	async function refreshTeam() {
		if (!svc.agentTeams) return;
		const tasks = [];
		const agents = safe(() => svc.agents?.roots?.() ?? []) ?? [];
		let ok = false;
		for (const agent of agents.slice(0, 8)) {
			try {
				const view = await svc.agentTeams.remoteView(agent);
				ok = true;
				for (const task of view?.tasks ?? []) tasks.push({ ...task, ownerSession: agent.sessionId });
			} catch {
				try {
					const list = await svc.agentTeams.listTasks(agent);
					ok = true;
					for (const task of list ?? []) tasks.push({ ...task, ownerSession: agent.sessionId });
				} catch {
					/* team is experimental; absence is normal */
				}
			}
		}
		state.team = { tasks, ok };
	}

	function timer(fn, ms) {
		const id = setInterval(() => {
			Promise.resolve()
				.then(fn)
				.catch(() => {});
		}, ms);
		id.unref?.();
		timers.push(id);
		return id;
	}

	/* ── boot ──────────────────────────────────────────────────────────── */

	subscribe();
	seedApprovals();
	seedJobs();
	timer(refreshSessionRecords, 15_000);
	timer(refreshSubagents, 5_000);
	timer(refreshTeam, 10_000);
	timer(() => {
		// Re-fold from the logs so a dropped event cannot leave a phantom
		// approval burning red forever. Approvals that survive the re-fold are
		// not re-announced.
		const known = new Set(state.pending.keys());
		state.pending.clear();
		seedApprovals(known);
	}, 60_000);
	Promise.resolve().then(() => {
		refreshSessionRecords().catch(() => {});
		refreshSubagents().catch(() => {});
		refreshTeam().catch(() => {});
	});

	/* ── projections ───────────────────────────────────────────────────── */

	function projection(session, key) {
		if (!svc.sessionProjections) return undefined;
		return safe(() => svc.sessionProjections.stateOf(session, key));
	}

	function sessionLabel(session) {
		const header = session?.header ?? {};
		const title = projection(session, 'title');
		if (typeof title === 'string' && title.trim()) return clampText(title, 90);
		const cwd = baseName(header.cwd);
		if (cwd) return `${cwd} · ${shortId(header.id)}`;
		return shortId(header.id);
	}

	function inboxDepth(session) {
		const inbox = projection(session, 'inbox');
		if (!inbox || typeof inbox !== 'object') return 0;
		return count(inbox['next-turn']?.length) + count(inbox['next-step']?.length);
	}

	function todoProgress(session) {
		const todos = projection(session, 'todos');
		if (!Array.isArray(todos) || todos.length === 0) return null;
		const done = todos.filter((t) => t?.status === 'completed').length;
		return { done, total: todos.length };
	}

	/* ── snapshot ──────────────────────────────────────────────────────── */

	function buildCards(now, agents, sessionsById, alertsBySession) {
		const cards = [];
		const seen = new Set();

		for (const agent of agents) {
			const id = String(agent?.sessionId ?? '');
			if (!id || seen.has(id)) continue;
			seen.add(id);
			const session = sessionsById.get(id);
			if (!session) continue;

			const header = session.header ?? {};
			const goal = safe(() => svc.goals?.get(agent)) ?? projection(session, 'goal') ?? null;
			const stats = projection(session, 'sessionStats') ?? {};
			const pressure = projection(session, 'contextPressure') ?? {};
			const tokens = projection(session, 'tokenUsage') ?? {};
			const model = projection(session, 'modelSelection');
			const inbox = inboxDepth(session);
			const progress = todoProgress(session);

			const teamTasks = (state.team.tasks ?? []).filter((t) => t.ownerSession === id);
			const blockedTask = teamTasks.find((t) => t.ready === false);
			const activeTask = teamTasks.find((t) => t.status === 'in_progress') ?? teamTasks[0];

			let column = 'queued';
			let statusLabel = agent.status === 'running' ? '実行中' : '待機';
			let severity = 'ok';
			let title = sessionLabel(session);
			const badges = [];

			if (goal) {
				const phase = goal.phase;
				title = clampText(goal.objective || title, 120);
				badges.push('目標');
				if (phase === 'blocked') {
					column = 'alert';
					severity = 'alert';
					statusLabel = '遮断';
				} else if (phase === 'paused') {
					column = 'alert';
					severity = 'warn';
					statusLabel = '休止';
				} else if (phase === 'active') {
					column = agent.status === 'running' ? 'running' : 'queued';
				} else if (phase === 'complete') {
					column = agent.status === 'running' ? 'running' : 'queued';
				}
				if (goal.activation === 'disarmed' && column === 'running') {
					column = 'queued';
					statusLabel = '待機';
					badges.push('解除済み');
				}
			} else if (blockedTask) {
				column = 'alert';
				severity = 'warn';
				statusLabel = '依存待ち';
			} else if (agent.status === 'running') {
				column = 'running';
			} else if (inbox > 0) {
				column = 'queued';
				statusLabel = '未処理あり';
			}

			if (alertsBySession.get(id)?.length) severity = 'alert';

			const metrics = [];
			if (stats.steps > 0) metrics.push({ label: 'ステップ', value: String(count(stats.steps)) });
			if (stats.openStep) metrics.push({ label: '実行', value: '中' });
			if (tokens.outputTokens > 0 || tokens.uncachedInputTokens > 0) {
				metrics.push({
					label: 'トークン',
					value: compactNumber(count(tokens.outputTokens) + count(tokens.uncachedInputTokens)),
				});
			}
			if (inbox > 0) metrics.push({ label: '未処理', value: String(inbox) });
			if (progress) metrics.push({ label: 'ToDo', value: `${progress.done}/${progress.total}` });
			if (Number.isFinite(pressure.contextWindow) && pressure.contextWindow > 0) {
				const pct = Math.round(
					((count(pressure.projectedTokens) || count(pressure.pressureTokens)) /
						pressure.contextWindow) *
						100,
				);
				metrics.push({ label: '文脈', value: `${pct}%` });
			}

			cards.push({
				id: `session:${id}`,
				column,
				kind: 'session',
				title: clampText(title, 140),
				// The model is identical on every card, so it belongs in the page
				// header, not repeated eight times down the columns.
				subtitle: baseName(header.cwd),
				status: goal?.phase ?? agent.status ?? 'idle',
				statusLabel,
				severity,
				since: Number.isFinite(header.createdAt) ? header.createdAt : now,
				updatedAt: now,
				metrics: metrics.slice(0, 3),
				progress,
				badges,
				detail: {
					cwd: header.cwd ?? '',
					model: modelLine(model),
					sessionId: id,
					status: statusLabel,
					note: goal?.blockedReason?.message ?? activeTask?.subject ?? '',
					startedAt: Number.isFinite(header.createdAt) ? header.createdAt : null,
				},
			});
		}

		const jobs = safe(() => svc.jobs?.list() ?? []) ?? [];
		for (const job of jobs) {
			const finished = Number.isFinite(job.finishedAt) ? job.finishedAt : null;
			const settled = job.status !== 'running' && job.status !== 'stopping';
			let column;
			if (settled) {
				if (!finished || now - finished > DONE_WINDOW_MS) continue;
				column = job.status === 'completed' ? 'done' : 'alert';
			} else {
				column = 'running';
			}
			cards.push({
				id: `job:${job.id}`,
				column,
				kind: 'job',
				title: clampText(job.label ?? job.id, 140),
				subtitle: clampText(job.kind ?? '', 20),
				status: job.status,
				statusLabel: STATUS_LABEL[job.status] ?? job.status,
				severity: STATUS_SEVERITY[job.status] ?? 'ok',
				since: Number.isFinite(job.startedAt) ? job.startedAt : now,
				updatedAt: finished ?? now,
				metrics: [],
				progress: null,
				badges: [],
				detail: {
					kind: job.kind ?? '',
					status: job.status,
					ownerSession: job.ownerSession ?? '',
					startedAt: job.startedAt ?? null,
					finishedAt: job.finishedAt ?? null,
					note: clampText(job.detail ?? '', 200),
				},
			});
		}

		for (const task of state.team.tasks ?? []) {
			const status = task.status ?? 'pending';
			if (status === 'deleted') continue;
			let column = 'queued';
			if (status === 'completed') column = 'done';
			else if (status === 'in_progress') column = task.ready === false ? 'alert' : 'running';
			else if (task.ready === false) column = 'alert';
			cards.push({
				id: `task:${task.id ?? task.subject}`,
				column,
				kind: 'task',
				title: clampText(task.subject ?? task.title ?? task.id ?? 'タスク', 140),
				subtitle: task.owner ? `チーム / ${clampText(task.owner, 20)}` : 'チーム',
				status,
				statusLabel: STATUS_LABEL[status] ?? status,
				severity: task.ready === false || status === 'in_progress' ? 'warn' : 'ok',
				since: Number.isFinite(task.createdAt) ? task.createdAt : now,
				updatedAt: now,
				metrics: [],
				progress: null,
				badges: (task.writeScopeWarnings ?? []).length ? ['書込範囲注意'] : [],
				detail: {
					status,
					blockedBy: (task.blockedBy ?? []).join(', '),
					note: clampText(task.description ?? '', 400),
				},
			});
		}

		return cards.slice(0, MAX_CARDS);
	}

	function compactNumber(n) {
		if (!Number.isFinite(n)) return '0';
		if (n < 1000) return String(Math.round(n));
		if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
		return `${(n / 1_000_000).toFixed(2)}M`;
	}

	function modelLine(selection) {
		if (!selection || typeof selection !== 'object') return '';
		const provider = selection.provider ?? selection.providerId;
		const model = selection.model ?? selection.modelId;
		if (provider && model) return `${provider} ${model}`;
		if (model) return String(model);
		return '';
	}

	function snapshot() {
		const now = Date.now();

		const sessions = safe(() => svc.sessions?.list() ?? [], 'セッション一覧を取得できません') ?? [];
		const agents = safe(() => svc.agents?.list() ?? [], 'エージェント一覧を取得できません') ?? [];
		const sessionsById = new Map();
		for (const session of sessions) {
			const id = session?.header?.id;
			if (id) sessionsById.set(String(id), session);
		}
		const agentBySession = new Map();
		for (const agent of agents) {
			if (agent?.sessionId) agentBySession.set(String(agent.sessionId), agent);
		}

		// ── goals
		let goalsActive = 0;
		let goalsBlocked = 0;
		let goalsPaused = 0;
		for (const agent of agents) {
			const goal = safe(() => svc.goals?.get(agent));
			if (!goal) continue;
			if (goal.phase === 'active') goalsActive += 1;
			else if (goal.phase === 'blocked') goalsBlocked += 1;
			else if (goal.phase === 'paused') goalsPaused += 1;
		}

		// ── approvals (prune stale)
		for (const [id, entry] of state.pending) {
			if (now - entry.since > APPROVAL_TTL_MS) state.pending.delete(id);
		}
		const pendingApprovals = [...state.pending.values()].filter((entry) =>
			entry.sessionId ? sessionsById.has(String(entry.sessionId)) : true,
		);

		// ── jobs
		// A failed or killed job stays on the queue for JOB_ALERT_WINDOW_MS;
		// the counters must use the same window, because a wall board whose
		// big number and its breakdown disagree reads as broken.
		const jobs = safe(() => svc.jobs?.list() ?? []) ?? [];
		let jobsRunning = 0;
		let jobsFailed = 0;
		for (const job of jobs) {
			if (job.status === 'running' || job.status === 'stopping') {
				jobsRunning += 1;
				continue;
			}
			if (job.status !== 'failed' && job.status !== 'killed') continue;
			const finished = Number.isFinite(job.finishedAt) ? job.finishedAt : now;
			if (now - finished > JOB_ALERT_WINDOW_MS) continue;
			jobsFailed += 1;
		}

		// ── context pressure across live sessions
		let contextPct = 0;
		let contextWindow = 0;
		let contextTokens = 0;
		const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		for (const session of sessions) {
			const pressure = projection(session, 'contextPressure');
			if (pressure && Number.isFinite(pressure.contextWindow) && pressure.contextWindow > 0) {
				const used = count(pressure.projectedTokens) || count(pressure.pressureTokens);
				const pct = Math.round((used / pressure.contextWindow) * 100);
				if (pct > contextPct) {
					contextPct = pct;
					contextWindow = pressure.contextWindow;
					contextTokens = used;
				}
			}
			const usage = projection(session, 'tokenUsage');
			if (usage) {
				tokens.input += count(usage.uncachedInputTokens);
				tokens.output += count(usage.outputTokens);
				tokens.cacheRead += count(usage.cacheReadTokens);
				tokens.cacheWrite += count(usage.cacheWriteTokens);
			}
		}

		// ── alerts
		const alerts = [];
		const alertsBySession = new Map();
		const addAlert = (alert) => {
			alerts.push(alert);
			if (alert.sessionId) {
				const key = String(alert.sessionId);
				if (!alertsBySession.has(key)) alertsBySession.set(key, []);
				alertsBySession.get(key).push(alert);
			}
		};

		for (const entry of pendingApprovals) {
			const session = sessionsById.get(String(entry.sessionId));
			addAlert({
				id: `approval:${entry.id}`,
				kind: 'approval',
				severity: 'alert',
				title: `承認待ち: ${entry.toolName}`,
				detail: entry.reason,
				sessionId: entry.sessionId ?? null,
				sessionTitle: session ? sessionLabel(session) : '',
				since: entry.since,
			});
		}

		for (const agent of agents) {
			const goal = safe(() => svc.goals?.get(agent));
			if (!goal) continue;
			if (goal.phase === 'blocked') {
				addAlert({
					id: `goal-blocked:${goal.id ?? agent.sessionId}`,
					kind: 'goal',
					severity: 'alert',
					title: `目標が遮断: ${clampText(goal.objective, 70)}`,
					detail: goal.blockedReason?.message ?? goal.blockedReason?.code ?? '',
					sessionId: agent.sessionId,
					sessionTitle: '',
					since: Number.isFinite(goal.updatedAt) ? goal.updatedAt : now,
				});
			} else if (goal.phase === 'paused') {
				addAlert({
					id: `goal-paused:${goal.id ?? agent.sessionId}`,
					kind: 'goal',
					severity: 'warn',
					title: `目標が休止: ${clampText(goal.objective, 70)}`,
					detail: '',
					sessionId: agent.sessionId,
					sessionTitle: '',
					since: Number.isFinite(goal.updatedAt) ? goal.updatedAt : now,
				});
			}
		}

		for (const job of jobs) {
			if (job.status !== 'failed' && job.status !== 'killed') continue;
			const finished = Number.isFinite(job.finishedAt) ? job.finishedAt : now;
			if (now - finished > JOB_ALERT_WINDOW_MS) continue;
			addAlert({
				id: `job:${job.id}`,
				kind: 'job',
				severity: 'alert',
				title: `${STATUS_LABEL[job.status] ?? job.status}: ${clampText(job.label ?? job.id, 70)}`,
				detail: clampText(job.detail ?? '', 120),
				sessionId: job.ownerSession ?? null,
				sessionTitle: '',
				since: Number.isFinite(job.startedAt) ? job.startedAt : finished,
			});
		}

		if (state.subagentDiagnostics > 0) {
			addAlert({
				id: 'subagent:diagnostics',
				kind: 'error',
				severity: 'warn',
				title: `読み取れないサブエージェントが ${state.subagentDiagnostics}件`,
				detail: '',
				sessionId: null,
				sessionTitle: '',
				since: now,
			});
		}
		if (state.startupFailures > 0) {
			addAlert({
				id: 'agent:startup-failures',
				kind: 'error',
				severity: 'alert',
				title: `エージェント起動失敗が ${state.startupFailures}件`,
				detail: '',
				sessionId: null,
				sessionTitle: '',
				since: now,
			});
		}

		for (const alert of alerts) {
			if (alert.sessionId && !alert.sessionTitle) {
				const session = sessionsById.get(String(alert.sessionId));
				alert.sessionTitle = session ? sessionLabel(session) : '';
			}
		}
		alerts.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || a.since - b.since);

		const agentsRunning = agents.filter((a) => a?.status === 'running').length;
		const agentsIdle = agents.length - agentsRunning;
		const errors =
			jobsFailed + state.subagentDiagnostics + state.startupFailures;

		// ── the eight stations, fixed order (DESIGN.md §3.1)
		const stations = [
			{
				// Questions are deliberately excluded: dsh-user-questions exposes
				// only a waterfall event, and observing it wrong would break the
				// harness's ability to ask anything at all. Approvals carry the
				// same "a human is blocking the line" meaning and are observable
				// from the session log.
				id: 'needs-you',
				label: '要対応',
				value: pendingApprovals.length,
				suffix: '',
				hint: pendingApprovals.length ? `承認 ${pendingApprovals.length}` : '—',
				severity: pendingApprovals.length > 0 ? 'alert' : 'ok',
			},
			{
				id: 'running',
				label: '実行中',
				value: agentsRunning,
				suffix: '',
				hint: `エージェント ${agentsRunning}/${agents.length}`,
				severity: 'ok',
			},
			{
				id: 'sessions',
				label: 'セッション',
				value: sessions.length,
				suffix: '',
				hint: state.sessionsTotal ? `全体 ${state.sessionsTotal}` : '生存のみ',
				severity: 'ok',
			},
			{
				// An alarm-capable station carries the count that drives its
				// severity: the andon rail prints station.value, and a row lit
				// red must never be showing a healthy number.
				id: 'jobs',
				label: 'ジョブ',
				value: jobsFailed,
				suffix: '',
				hint: `稼働 ${jobsRunning} / 失敗 ${jobsFailed}`,
				severity: jobsFailed > 0 ? 'alert' : 'ok',
			},
			{
				id: 'subagents',
				label: 'サブ',
				value: state.subagentRunning,
				suffix: '',
				hint: state.subagentDiagnostics > 0 ? `診断 ${state.subagentDiagnostics}` : '—',
				severity: 'ok',
			},
			{
				id: 'goals',
				label: '目標',
				value: goalsBlocked + goalsPaused,
				suffix: '',
				hint: `遮断 ${goalsBlocked} / 休止 ${goalsPaused} / 稼働 ${goalsActive}`,
				severity: goalsBlocked > 0 ? 'warn' : goalsPaused > 0 ? 'warn' : 'ok',
			},
			{
				id: 'context',
				label: '文脈',
				value: contextPct,
				suffix: '%',
				hint: contextWindow ? `${compactNumber(contextTokens)} / ${compactNumber(contextWindow)}` : '—',
				severity: contextPct >= 90 ? 'alert' : contextPct >= 75 ? 'warn' : 'ok',
			},
			{
				id: 'errors',
				label: '異常',
				value: errors,
				suffix: '',
				hint: `失敗 ${jobsFailed} / 診断 ${state.subagentDiagnostics} / 起動 ${state.startupFailures}`,
				severity: errors > 0 ? 'alert' : 'ok',
			},
		];

		let status = 'ok';
		for (const station of stations) {
			if (station.severity === 'alert') status = 'alert';
			else if (station.severity === 'warn' && status === 'ok') status = 'warn';
		}

		// ── cards
		const cards = buildCards(now, agents, sessionsById, alertsBySession);

		// ── vitals
		const workspaces = safe(() => svc.workspaceRegistry?.list() ?? []) ?? [];
		const primaryWorkspace = workspaces.find((w) => w?.active) ?? workspaces[0];
		let modelSelection = null;
		for (const session of sessions) {
			modelSelection = projection(session, 'modelSelection');
			if (modelSelection) break;
		}

		return {
			schema: 1,
			generatedAt: now,
			status,
			host: {
				pid: process.pid,
				uptimeSec: Math.round(process.uptime()),
				node: process.versions.node,
				platform: process.platform,
			},
			counts: {
				liveSessions: sessions.length,
				agentsRunning,
				agentsIdle,
				jobsRunning,
				jobsFailed,
				subagentsRunning: state.subagentRunning,
				pendingApprovals: pendingApprovals.length,
				pendingQuestions: state.questions,
				goalsActive,
				goalsBlocked,
				goalsPaused,
				sessionsTotal: state.sessionsTotal,
			},
			stations,
			alerts: alerts.slice(0, MAX_ALERTS),
			cards,
			activity: state.activity.slice(0, MAX_ACTIVITY),
			vitals: {
				profile: process.env.DSH_PROFILE ?? 'web',
				workspace: clampText(
					primaryWorkspace?.path ??
						primaryWorkspace?.root ??
						primaryWorkspace?.cwd ??
						process.cwd(),
					120,
				),
				model: modelLine(modelSelection),
				contextPct,
				contextWindow,
				contextTokens,
				tokens,
				hostTotalSessions: state.sessionsTotal,
			},
			notes: [...notes],
		};
	}

	function dispose() {
		for (const disposer of disposers) safe(() => disposer());
		disposers.length = 0;
		for (const id of timers) clearInterval(id);
		timers.length = 0;
	}

	return { snapshot, dispose, get pending() { return state.pending; } };
}
