/* dsh-andon / kanban.js — the operations board renderer.
 *
 * Contract: DESIGN.md §3.2 and §5. The shell is static in kanban.html; this
 * file patches values in and reuses card nodes so hover, scroll position and
 * an open drawer all survive the 3-second poll.
 *
 * Cards arrive already assigned to a column by the server. This file never
 * re-derives the column: the server owns that rule, the client only orders
 * within one.
 */

import {
	baseName,
	bindKeys,
	clampText,
	clear,
	createConnection,
	createPoller,
	fmtDur,
	fmtDurLong,
	fmtNum,
	h,
	setTitle,
	startClock,
	SEV_RANK,
} from './board.js';

const $ = (id) => document.getElementById(id);

const COLUMNS = [
	{ id: 'alert', label: '要対応', empty: '対応が必要なものはありません' },
	{ id: 'running', label: '実行中', empty: 'いま動いているものはありません' },
	{ id: 'queued', label: '待機', empty: '待ちの作業はありません' },
	{ id: 'done', label: '完了・直近', empty: '直近の完了はありません' },
];

const STATUS_LABEL = {
	running: '実行中',
	idle: '待機',
	completed: '完了',
	killed: '停止',
	failed: '失敗',
	stopping: '停止中',
	pending: '未着手',
	in_progress: '進行中',
	blocked: '遮断',
	paused: '休止',
};

const DETAIL_LABEL = {
	cwd: '作業ディレクトリ',
	model: 'モデル',
	sessionId: 'セッションID',
	owner: '所有セッション',
	ownerSession: '所有セッション',
	kind: '種別',
	note: '備考',
	startedAt: '開始',
	finishedAt: '終了',
	status: '状態',
	objective: '目標',
	preset: 'プリセット',
};

const refs = {
	conn: $('conn'),
	clock: $('clock'),
	model: $('h-model'),
	uptime: $('h-uptime'),
	tokens: $('h-tokens'),
	errAt: $('err-at'),
	v: {
		running: $('v-running'),
		agentsHint: $('v-agents-hint'),
		jobs: $('v-jobs'),
		jobsHint: $('v-jobs-hint'),
		goals: $('v-goals'),
		goalsHint: $('v-goals-hint'),
		context: $('v-context-n'),
		contextBar: $('v-context-bar'),
		workspace: $('v-workspace'),
		sessionsHint: $('v-sessions-hint'),
	},
	actN: $('act-n'),
	actRows: $('act-rows'),
	cols: Object.fromEntries(
		COLUMNS.map((c) => [
			c.id,
			{
				spec: c,
				root: $(`col-${c.id}`),
				count: $(`col-${c.id}`).querySelector('.col-n'),
				body: $(`col-${c.id}`).querySelector('.col-body'),
			},
		]),
	),
	drawer: $('drawer'),
	dwTitle: $('dw-title'),
	dwPills: $('dw-pills'),
	dwRows: $('dw-rows'),
	dwClose: $('dw-close'),
};

const connection = createConnection(refs.conn, { staleAfterMs: 9000 });
startClock(refs.clock);
document.body.dataset.stale = '0';

/* ── helpers ─────────────────────────────────────────────────────────────── */

function setText(node, text) {
	if (!node) return;
	const value = text === null || text === undefined ? '—' : String(text);
	if (node.textContent !== value) node.textContent = value;
}

/** Oldest first inside a severity tier, so the thing waiting longest is on top. */
function orderCards(cards, column) {
	const copy = [...cards];
	if (column === 'alert') {
		copy.sort(
			(a, b) =>
				(SEV_RANK[a.severity] ?? 2) - (SEV_RANK[b.severity] ?? 2) ||
				(a.since ?? 0) - (b.since ?? 0),
		);
	} else {
		copy.sort((a, b) => (b.updatedAt ?? b.since ?? 0) - (a.updatedAt ?? a.since ?? 0));
	}
	return copy;
}

/* ── cards ───────────────────────────────────────────────────────────────── */

const cardNodes = new Map(); // id -> { el, title, sub, chip, age, metrics, progress }
const cardsById = new Map(); // id -> latest card payload, for the drawer

function makeCard(id) {
	const title = h('div', { class: 'card-title' });
	const sub = h('div', { class: 'card-sub' });
	const chip = h('span', { class: 'chip' });
	const age = h('span', { class: 'card-age num' });
	const foot = h('div', { class: 'card-foot' }, chip, age);
	const metrics = h('div', { class: 'card-metrics' });
	const progressBar = h('i');
	const progressN = h('span', { class: 'n num' });
	const barEl = h('div', { class: 'bar' }, progressBar);
	const progress = h('div', { class: 'card-progress' }, barEl, progressN);
	const el = h('button', { class: 'card', type: 'button' }, title, sub, foot, metrics, progress);
	el.addEventListener('click', () => openDrawer(id, el));
	const entry = { el, title, sub, chip, age, metrics, progress, barEl, progressBar, progressN };
	cardNodes.set(id, entry);
	return entry;
}

function fillCard(entry, card, now) {
	const title = clampText(card.title ?? '', 120);
	entry.title.textContent = title || '無題';
	entry.title.dataset.empty = title ? '0' : '1';

	const sub = clampText(card.subtitle ?? '', 80);
	entry.sub.textContent = sub;
	entry.sub.hidden = !sub;

	const sev = card.severity === 'alert' || card.severity === 'warn' ? card.severity : 'ok';
	entry.chip.dataset.sev = sev;
	entry.chip.textContent = card.statusLabel || STATUS_LABEL[card.status] || card.kind || '—';

	const since = card.updatedAt ?? card.since;
	entry.el.title = `${title}\n${card.statusLabel ?? ''}`;
	entry.age.textContent = since ? fmtDur(now - since) : '—';

	clear(entry.metrics);
	const metrics = (card.metrics ?? []).slice(0, 3);
	entry.metrics.hidden = metrics.length === 0;
	for (const metric of metrics) {
		entry.metrics.appendChild(
			h(
				'div',
				{ class: 'metric' },
				h('span', { class: 'metric-l', text: clampText(metric.label, 12) }),
				h('span', { class: 'metric-v num', text: clampText(metric.value, 14) }),
			),
		);
	}

	// A bar is only honest when there is a real todo list behind it.
	const progress = card.progress;
	if (progress && Number.isFinite(progress.total) && progress.total > 0) {
		entry.progress.hidden = false;
		const ratio = Math.min(1, Math.max(0, progress.done / progress.total));
		entry.progressBar.style.width = `${(ratio * 100).toFixed(1)}%`;
		entry.progressN.textContent = `${progress.done}/${progress.total}`;
		entry.barEl.dataset.sev = sev;
	} else {
		entry.progress.hidden = true;
	}
}

function renderColumns(cards, now) {
	const byColumn = new Map(COLUMNS.map((c) => [c.id, []]));
	for (const card of cards) {
		byColumn.get(card.column)?.push(card);
	}

	const used = new Set();

	for (const spec of COLUMNS) {
		const view = refs.cols[spec.id];
		const list = orderCards(byColumn.get(spec.id) ?? [], spec.id);

		clear(view.body);
		setText(view.count, list.length);
		if (spec.id === 'alert') view.count.dataset.hot = list.length > 0 ? '1' : '0';

		if (!list.length) {
			view.body.appendChild(h('p', { class: 'empty', text: spec.empty }));
			continue;
		}
		for (const card of list) {
			used.add(card.id);
			cardsById.set(card.id, card);
			const entry = cardNodes.get(card.id) ?? makeCard(card.id);
			fillCard(entry, card, now);
			view.body.appendChild(entry.el); // moves, does not rebuild
		}
	}

	for (const id of cardNodes.keys()) {
		if (!used.has(id)) {
			cardNodes.delete(id);
			cardsById.delete(id);
		}
	}

	// Keep the open drawer honest even when its card changed or vanished.
	if (openId) {
		const card = cardsById.get(openId);
		if (card) fillDrawer(card, now);
		else closeDrawer();
	}
}

/* ── vitals ──────────────────────────────────────────────────────────────── */

function renderVitals(state) {
	const counts = state.counts ?? {};
	const vitals = state.vitals ?? {};
	const host = state.host ?? {};

	setText(refs.v.running, counts.agentsRunning ?? 0);
	setText(
		refs.v.agentsHint,
		`稼働中 / 全体 ${counts.agentsRunning ?? 0} / ${(counts.agentsRunning ?? 0) + (counts.agentsIdle ?? 0)}`,
	);

	setText(refs.v.jobs, counts.jobsRunning ?? 0);
	setText(refs.v.jobsHint, `失敗 ${counts.jobsFailed ?? 0}`);
	refs.v.jobs.classList.toggle('sev-alert', (counts.jobsFailed ?? 0) > 0);

	setText(refs.v.goals, counts.goalsActive ?? 0);
	setText(refs.v.goalsHint, `遮断 ${counts.goalsBlocked ?? 0} / 休止 ${counts.goalsPaused ?? 0}`);

	const pct = Number.isFinite(vitals.contextPct) ? Math.round(vitals.contextPct) : null;
	setText(refs.v.context, pct === null ? '—' : pct);
	refs.v.contextBar.style.width = `${pct === null ? 0 : Math.min(100, Math.max(0, pct))}%`;
	const gauge = refs.v.contextBar.parentElement;
	gauge.dataset.sev = pct === null ? '' : pct >= 90 ? 'alert' : pct >= 75 ? 'warn' : '';

	setText(refs.v.workspace, baseName(vitals.workspace ?? '') || '—');
	setText(
		refs.v.sessionsHint,
		`セッション ${counts.liveSessions ?? 0} / 全体 ${vitals.hostTotalSessions ?? counts.sessionsTotal ?? 0}`,
	);

	const tokens = vitals.tokens ?? {};
	const totalTokens =
		(tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0);
	setText(refs.tokens, fmtNum(totalTokens));

	setText(refs.model, clampText(vitals.model ?? '', 40));
	setText(refs.uptime, Number.isFinite(host.uptimeSec) ? fmtDurLong(host.uptimeSec * 1000) : '—');
}

function renderActivity(state) {
	const activity = state.activity ?? [];
	setText(refs.actN, activity.length);
	clear(refs.actRows);
	if (!activity.length) {
		refs.actRows.appendChild(h('p', { class: 'empty', text: 'まだ動きはありません' }));
		return;
	}
	const now = Date.now();
	for (const item of activity.slice(0, 8)) {
		const sev = item.severity === 'alert' || item.severity === 'warn' ? item.severity : 'ok';
		refs.actRows.appendChild(
			h(
				'div',
				{ class: 'arow', dataset: { sev } },
				h('span', { class: 'atime num', text: fmtDur(now - item.at) }),
				h('span', { class: 'adot' }),
				h('span', { class: 'atext', text: clampText(item.text, 110) }),
			),
		);
	}
}

/* ── detail drawer ───────────────────────────────────────────────────────── */

let openId = null;
let opener = null;

function fmtStamp(ts) {
	if (!Number.isFinite(ts)) return '—';
	const d = new Date(ts);
	const p = (n) => String(n).padStart(2, '0');
	return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fillDrawer(card, now) {
	setText(refs.dwTitle, clampText(card.title ?? '無題', 160));

	clear(refs.dwPills);
	const sev = card.severity === 'alert' || card.severity === 'warn' ? card.severity : 'ok';
	refs.dwPills.appendChild(
		h('span', {
			class: 'chip',
			dataset: { sev },
			text: card.statusLabel || STATUS_LABEL[card.status] || '—',
		}),
	);
	for (const badge of card.badges ?? []) {
		refs.dwPills.appendChild(h('span', { class: 'chip', text: clampText(badge, 24) }));
	}
	const since = card.updatedAt ?? card.since;
	if (since) {
		refs.dwPills.appendChild(h('span', { class: 'chip num', text: fmtDurLong(now - since) }));
	}

	const rows = [];
	for (const metric of card.metrics ?? []) {
		rows.push([metric.label, metric.value]);
	}
	if (card.progress && card.progress.total > 0) {
		rows.push(['進捗', `${card.progress.done} / ${card.progress.total}`]);
	}
	if (card.subtitle) rows.push(['要約', card.subtitle]);
	for (const [key, value] of Object.entries(card.detail ?? {})) {
		if (value === null || value === undefined || value === '') continue;
		const label = DETAIL_LABEL[key] ?? key;
		const text = typeof value === 'number' && /at$/i.test(key) ? fmtStamp(value) : String(value);
		rows.push([label, clampText(text, 400)]);
	}

	clear(refs.dwRows);
	if (!rows.length) {
		refs.dwRows.appendChild(h('p', { class: 'empty', text: '詳細はありません' }));
		return;
	}
	for (const [key, value] of rows) {
		refs.dwRows.appendChild(
			h(
				'div',
				{ class: 'dw-row' },
				h('span', { class: 'dw-k', text: clampText(key, 20) }),
				h('span', { class: 'dw-v', text: String(value) }),
			),
		);
	}
}

function openDrawer(id, trigger) {
	const card = cardsById.get(id);
	if (!card) return;
	openId = id;
	opener = trigger;
	fillDrawer(card, Date.now());
	if (!refs.drawer.open) refs.drawer.showModal();
}

function closeDrawer() {
	openId = null;
	if (refs.drawer.open) refs.drawer.close();
	opener?.focus?.();
	opener = null;
}

refs.dwClose.addEventListener('click', closeDrawer);
refs.drawer.addEventListener('close', () => {
	openId = null;
	opener = null;
});

/* ── render loop ─────────────────────────────────────────────────────────── */

let lastGoodAt = null;

function render(state) {
	const now = Date.now();
	renderVitals(state);
	renderColumns(state.cards ?? [], now);
	renderActivity(state);

	lastGoodAt = now;
	document.body.dataset.down = '0';
	document.body.dataset.stale = '0';
	connection.update();
	setTitle(state.status, 'DSH カンバン');
}

function renderError(_error, failures, lastGood) {
	connection.fail();
	document.body.dataset.stale = '1';
	if (lastGood) document.body.dataset.down = failures >= 2 ? '1' : '0';
	else document.body.dataset.down = '1';
	setText(refs.errAt, lastGoodAt ? `最終更新 ${new Date(lastGoodAt).toLocaleTimeString('ja-JP')}` : '');
}

const poller = createPoller({
	url: '/api/andon/state',
	intervalMs: 3000,
	onData: (state) => {
		try {
			render(state);
		} catch (error) {
			document.body.dataset.stale = '1';
			console.error('kanban render failed', error);
		}
	},
	onError: renderError,
});

bindKeys({
	onRefresh: () => poller.refresh(),
	onOther: () => location.assign('/andon'),
});
