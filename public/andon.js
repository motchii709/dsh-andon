/* dsh-andon / andon.js — the wall board's renderer.
 *
 * Contract: DESIGN.md §3.1 and §5. The whole shell (rail labels, field,
 * ticker) is already in andon.html; this file only patches values in and
 * reuses nodes, so nothing flickers on a 2-second poll.
 *
 * Three zones, three jobs:
 *   rail   — the eight stations, numbered; a calling station lights solid
 *   field  — the colour (status) and the two numbers you read across a room
 *   ticker — what called, and the clock
 *
 * The field colour is set from state.status alone: green running, yellow
 * attention, red stopped. That single background is the primary alarm, which
 * is why nothing here is a small coloured dot on a dark page.
 */

import {
	bindKeys,
	clampText,
	clear,
	createConnection,
	createPoller,
	fmtClockShort,
	fmtDurLong,
	h,
	setTitle,
	startClock,
} from './board.js';

const $ = (id) => document.getElementById(id);

const STATION_IDS = [
	'needs-you',
	'running',
	'sessions',
	'jobs',
	'subagents',
	'goals',
	'context',
	'errors',
];

const refs = {
	board: $('board'),
	statusWord: $('status-word'),
	statusSub: $('status-sub'),
	counter: $('counter'),
	alertCount: $('alert-count'),
	host: $('host'),
	clock: $('clock'),
	conn: $('conn'),
	alertList: $('alert-list'),
	notes: $('notes'),
	rows: {},
};

for (const id of STATION_IDS) {
	const el = $(`st-${id}`);
	refs.rows[id] = el ? { el, value: el.querySelector('.sr-v') } : null;
}

const connection = createConnection(refs.conn, { staleAfterMs: 6000 });
startClock(refs.clock);

const STATUS_WORD = { alert: '要対応', warn: '注意', ok: '正常' };

/** One line telling the operator what to do. Counts, not a sentence: a number
 *  is something you can act on. This line and the lit rail rows always agree,
 *  because both come from the same counts. */
function statusSubline(state) {
	const counts = state.counts || {};
	if (state.status === 'ok') {
		return `異常なし · 実行中 ${counts.agentsRunning || 0} · セッション ${counts.liveSessions || 0}`;
	}
	const bits = [];
	if (counts.pendingApprovals) bits.push(`承認待ち ${counts.pendingApprovals}件`);
	if (counts.jobsFailed) bits.push(`ジョブ失敗 ${counts.jobsFailed}件`);
	if (counts.goalsBlocked) bits.push(`目標遮断 ${counts.goalsBlocked}件`);
	if (counts.goalsPaused) bits.push(`目標休止 ${counts.goalsPaused}件`);
	if (counts.subagentDiagnostics) bits.push(`診断不能 ${counts.subagentDiagnostics}件`);
	if (counts.startupFailures) bits.push(`起動失敗 ${counts.startupFailures}件`);
	if (!bits.length) {
		return state.status === 'alert' ? '対応が必要な項目があります' : '注意項目があります';
	}
	return bits.join(' · ');
}

/* ── the rail ────────────────────────────────────────────────────────────── */

function setText(node, text) {
	const value = text === null || text === undefined ? '—' : String(text);
	if (node.textContent !== value) node.textContent = value;
}

function renderStations(stations) {
	for (const station of stations) {
		const row = refs.rows[station.id];
		if (!row) continue;
		const sev =
			station.severity === 'alert' || station.severity === 'warn' ? station.severity : 'ok';
		if (row.el.dataset.sev !== sev) row.el.dataset.sev = sev;
		setText(row.value, `${station.value}${station.suffix || ''}`);
		// The breakdown stays a tooltip: the rail is a glance, and the field
		// sub-line already states the categories in words.
		row.el.title = `${station.label}: ${station.hint || ''}`;
	}
}

/* ── the ticker ──────────────────────────────────────────────────────────── */

const tickRows = new Map();

function tickRow(id) {
	let entry = tickRows.get(id);
	if (entry) return entry;
	const dot = h('span', { class: 'tdot' });
	const text = h('span', { class: 'ttext' });
	const time = h('span', { class: 'ttime num' });
	const el = h('div', { class: 'trow' }, dot, text, time);
	entry = { el, dot, text, time };
	tickRows.set(id, entry);
	return entry;
}

/** Calls first. The ticker is the board's answer to "which one called?", so a
 *  live alarm always outranks the log; only when nothing is calling does it
 *  fall back to the most recent activity. */
function renderTicker(alerts, activity) {
	const live = new Set();
	const lines = [];

	for (const alert of alerts.slice(0, 3)) {
		lines.push({
			id: `a:${alert.id}`,
			sev: alert.severity === 'alert' ? 'alert' : 'warn',
			text: clampText(alert.title, 90),
			time: alert.since ? fmtClockShort(alert.since) : '',
		});
	}
	if (!lines.length) {
		for (const item of activity.slice(0, 3)) {
			// The collector folds repeats into `count`; print it as ×N so three
			// turns of the same event read as one counted line instead of three
			// rows that all say 応答 and distinguish nothing.
			const repeat = Number(item.count) > 1 ? ` ×${item.count}` : '';
			lines.push({
				id: `l:${item.at}:${lines.length}`,
				sev: item.severity === 'alert' || item.severity === 'warn' ? item.severity : 'ok',
				text: clampText(item.text + repeat, 90),
				time: fmtClockShort(item.at),
			});
		}
	}

	clear(refs.alertList);
	if (!lines.length) {
		refs.alertList.appendChild(
			h(
				'div',
				{ class: 'trow', dataset: { sev: 'ok' } },
				h('span', { class: 'tdot' }),
				h('span', { class: 'ttext', text: '動きなし' }),
			),
		);
	} else {
		for (const line of lines) {
			live.add(line.id);
			const row = tickRow(line.id);
			row.el.dataset.sev = line.sev;
			setText(row.text, line.text);
			setText(row.time, line.time);
			// Re-appending an existing node MOVES it; it is not rebuilt.
			refs.alertList.appendChild(row.el);
		}
		if (alerts.length > lines.length) {
			refs.alertList.appendChild(
				h('p', { class: 'more', text: `ほか ${alerts.length - lines.length}件` }),
			);
		}
	}

	for (const id of tickRows.keys()) {
		if (!live.has(id)) tickRows.delete(id);
	}
}

/* ── render ──────────────────────────────────────────────────────────────── */

let lastGoodAt = null;

function render(state) {
	const now = Date.now();
	const status = state.status === 'warn' || state.status === 'alert' ? state.status : 'ok';
	const alerts = state.alerts || [];

	// The colour field. This line is the alarm.
	if (refs.board.dataset.status !== status) refs.board.dataset.status = status;

	setText(refs.statusWord, STATUS_WORD[status]);
	setText(refs.statusSub, statusSubline(state));
	setText(refs.alertCount, String(alerts.length));
	refs.counter.dataset.sev = alerts.length ? 'alert' : 'ok';

	renderStations(state.stations || []);
	renderTicker(alerts, state.activity || []);

	const vitals = state.vitals || {};
	const host = state.host || {};
	const bits = [];
	if (vitals.profile) bits.push(vitals.profile);
	if (Number.isFinite(host.uptimeSec)) bits.push(`稼働 ${fmtDurLong(host.uptimeSec * 1000)}`);
	setText(refs.host, bits.join(' · ') || '—');

	const notes = state.notes || [];
	if (notes.length) {
		refs.notes.textContent = clampText(`取得できない項目: ${notes.join(' / ')}`, 120);
		refs.notes.hidden = false;
	} else {
		refs.notes.hidden = true;
	}

	lastGoodAt = now;
	document.body.dataset.down = '0';
	document.body.dataset.stale = '0';
	connection.update();
	setTitle(status, 'DSH アンドン');
}

function renderError(_error, failures, lastGood) {
	connection.fail();
	document.body.dataset.stale = '1';
	// A wall board never blanks: the numbers stay, the field turns grey, and
	// the reason appears in the line under the word.
	document.body.dataset.down = lastGood && failures < 2 ? '0' : '1';
	const suffix = lastGoodAt ? ` · 最終更新 ${fmtClockShort(lastGoodAt)}` : '';
	setText(refs.statusSub, `接続できません${suffix}`);
}

const poller = createPoller({
	url: '/api/andon/state',
	intervalMs: 2000,
	onData: (state) => {
		try {
			render(state);
		} catch (error) {
			// A render bug must not take the wall board down; keep the frame.
			document.body.dataset.stale = '1';
			console.error('andon render failed', error);
		}
	},
	onError: renderError,
});

bindKeys({
	onRefresh: () => poller.refresh(),
	onOther: () => location.assign('/kanban'),
});
