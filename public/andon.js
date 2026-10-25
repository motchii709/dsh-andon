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
	canFullscreen,
	createPoller,
	fmtClockShort,
	fmtDur,
	fmtDurLong,
	h,
	isFullscreen,
	setTitle,
	startClock,
	toggleFullscreen,
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
	statusWho: $('status-who'),
	fs: $('fs'),
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

// 全画面ボタン。API が無い環境では出さない（押しても何も起きないボタンは嘘）。
if (refs.fs) {
	if (canFullscreen()) {
		refs.fs.addEventListener('click', () => {
			toggleFullscreen();
			// 反映は非同期なので、状態が変わったらだけ印を付け直す
			setTimeout(() => {
				document.body.dataset.fs = isFullscreen() ? '1' : '0';
			}, 120);
		});
		document.body.dataset.fs = isFullscreen() ? '1' : '0';
	} else {
		refs.fs.hidden = true;
	}
}
/* 実画面の高さを CSS 変数に入れる。
 *
 * `100vh` はブラウザの URL バーを含む高さなので、バーが出ている間は盤の下端
 * （黒いチッカーと全画面ボタン）が画面外に出る。Fire タブの Silk は `dvh` を
 * 解釈しないため、そのままでは下が切れて押せない。visualViewport があれば
 * それ（実際に見えている高さ）、無ければ innerHeight を使う。
 * 回転・バー伸縮・全画面の出入りで値が変わるので、resize のたびに入れ直す。 */
function fitViewport() {
	const view = window.visualViewport;
	const h = Math.round((view && view.height) || window.innerHeight || 0);
	if (h > 0) document.documentElement.style.setProperty('--app-h', `${h}px`);
}

/* `?diag=1` のときだけ、実測値を画面に出す。
 *
 * 実機で「下が切れる」と言われたとき、こちらから画面を見られないと当てずっぽう
 * になる。ブラウザが申告している高さを本人に読んでもらうのが最短だった。
 * 通常は一切出ない（要素も作らない）。 */
function showDiag() {
	if (String(location.search).indexOf('diag=1') === -1) return;
	const view = window.visualViewport;
	const board = refs.board;
	const ticker = document.querySelector('.ticker');
	const line = () => {
		const box = board ? board.getBoundingClientRect() : { height: 0, bottom: 0 };
		const tick = ticker ? ticker.getBoundingClientRect() : { height: 0, bottom: 0 };
		return [
			`inner=${window.innerHeight}`,
			`vv=${view && view.height ? Math.round(view.height) : 'none'}`,
			`doc=${document.documentElement.clientHeight}`,
			`board=${Math.round(box.height)}`,
			`boardBottom=${Math.round(box.bottom)}`,
			`ticker=${Math.round(tick.height)}`,
			`tickerBottom=${Math.round(tick.bottom)}`,
			`app-h=${getComputedStyle(document.documentElement).getPropertyValue('--app-h').trim() || 'none'}`,
		].join('  ');
	};
	const box = document.createElement('div');
	box.style.cssText =
		'position:fixed;left:0;right:0;top:0;z-index:99;background:#000;color:#0f0;' +
		'font:12px/1.4 monospace;padding:4px 8px;white-space:pre-wrap;pointer-events:none';
	box.textContent = line();
	document.body.appendChild(box);
	setInterval(() => {
		box.textContent = line();
	}, 1000);
}

showDiag();
fitViewport();
window.addEventListener('resize', fitViewport);
window.addEventListener('orientationchange', fitViewport);
if (window.visualViewport) window.visualViewport.addEventListener('resize', fitViewport);
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

/** どのセッションが問題か。色と状態語だけでは「要対応」しか伝わらず、
 *  開くべきセッションを探す手間が残る（実機を見た指摘）。
 *
 *  正常のときは空。名前は 40 文字で切り、3件まで出して残りは「他N件」。 */
function renderWho(state) {
	const host = refs.statusWho;
	if (!host) return;
	const list = (state.sessions || [])
		.filter((s) => s.state === 'needs-you' || s.state === 'alarm')
		.sort((a, b) => (a.state === 'alarm' ? -1 : 0) - (b.state === 'alarm' ? -1 : 0) || (a.since || 0) - (b.since || 0));
	clear(host);
	if (!list.length || state.overall === 'normal') {
		host.hidden = true;
		return;
	}
	host.hidden = false;
	for (const session of list.slice(0, 3)) {
		const li = h('li');
		li.appendChild(h('span', { text: clampText(session.name || session.id || '', 40) }));
		if (session.reason) {
			li.appendChild(h('span', { class: 'who-why', text: `  ${clampText(session.reason, 24)}` }));
		}
		host.appendChild(li);
	}
	if (list.length > 3) {
		host.appendChild(h('li', { class: 'who-why', text: `他${list.length - 3}件` }));
	}
}
/** 静かなときの一行。数字だけを並べる（形容詞は書かない）。 */
function calmLine(state) {
	const c = state.counts || {};
	const running = typeof c.running === 'number' ? c.running : 0;
	const sessions = typeof c.sessions === 'number' ? c.sessions : 0;
	return `異常なし · 実行中 ${running} · セッション ${sessions}`;
}
/** レール8局を、v2 の細い形（counts）から組み立てる。
 *
 *  サーバの stations と同じ定義・同じ並び・同じ severity にする（画面と
 *  数字が食い違うと「どちらが本当か」を読み手に考えさせる）。足りない値は
 *  0 ではなく「—」を出す: 0 は「無い」という主張になる。 */
function buildStations(state) {
	const c = state.counts || {};
	const n = (key) => (typeof c[key] === 'number' ? c[key] : null);
	const dash = (v) => (v === null ? '—' : String(v));
	const jobsFailed = n('jobsFailed');
	const goalsBlocked = n('goalsBlocked');
	const goalsPaused = n('goalsPaused');
	const contextMax = n('contextMax');
	const errors = n('errors');
	return [
		{
			id: 'needs-you',
			label: '要対応',
			value: c.needsYou || 0,
			suffix: '',
			hint: c.needsYou ? `承認・入力待ち ${c.needsYou}` : '—',
			severity: c.needsYou > 0 ? 'alert' : 'ok',
		},
		{ id: 'running', label: '実行中', value: c.running || 0, suffix: '', hint: 'エージェント', severity: 'ok' },
		{ id: 'sessions', label: 'セッション', value: c.sessions || 0, suffix: '', hint: '生存のみ', severity: 'ok' },
		{
			id: 'jobs',
			label: 'ジョブ',
			value: jobsFailed === null ? '—' : jobsFailed,
			suffix: '',
			hint: `稼働 ${dash(n('jobsRunning'))} / 失敗 ${dash(jobsFailed)}`,
			severity: jobsFailed > 0 ? 'alert' : 'ok',
		},
		{ id: 'subagents', label: 'サブ', value: dash(n('subagents')), suffix: '', hint: '—', severity: 'ok' },
		{
			id: 'goals',
			label: '目標',
			value: goalsBlocked === null && goalsPaused === null ? '—' : (goalsBlocked || 0) + (goalsPaused || 0),
			suffix: '',
			hint: `遮断 ${dash(goalsBlocked)} / 休止 ${dash(goalsPaused)}`,
			severity: goalsBlocked > 0 || goalsPaused > 0 ? 'warn' : 'ok',
		},
		{
			id: 'context',
			label: '文脈',
			value: contextMax === null ? '—' : contextMax,
			suffix: contextMax === null ? '' : '%',
			hint: '最大',
			severity: contextMax >= 90 ? 'alert' : contextMax >= 75 ? 'warn' : 'ok',
		},
		{
			id: 'errors',
			label: '異常',
			value: errors === null ? '—' : errors,
			suffix: '',
			hint: '失敗・診断',
			severity: errors > 0 ? 'alert' : 'ok',
		},
	];
}

/** v2 の log[{at,session,severity,text}] を、v1 の activity 形に寄せる。
 *
 *  正常のときは平穏な行だけ流す。緑の全面に赤い「承認待ち」が並ぶと、
 *  盤が「正常」と「要対応」を同時に主張していることになり、どちらを信じるか
 *  読み手に考えさせる。警報色の行は、警報が出ているときだけ出す。 */
function logAsActivity(log, overall) {
	const calm = overall === 'normal';
	return (log || [])
		.filter((line) => !calm || line.severity === 'ok')
		.map((line) => ({
			at: line.at,
			severity: line.severity,
			text: line.session ? `${line.session}: ${line.text}` : line.text,
		}));
}
function renderStations(stations, v2counts) {
	// v1 の「要対応」は承認待ちしか数えない。v2 の needsYou は入力待ちも含むので、
	// 大表示（要対応 n件）とレールの数字が食い違う。盤の数字同士が矛盾すると
	// 「どちらが本当か」を読み手に考えさせるので、v2 の値を優先する。
	const needsYou =
		v2counts && typeof v2counts.needsYou === 'number' ? v2counts.needsYou : null;
	for (const station of stations) {
		const row = refs.rows[station.id];
		if (!row) continue;
		let value = station.value;
		if (station.id === 'needs-you' && needsYou !== null) value = needsYou;
		const sev =
			station.severity === 'alert' || station.severity === 'warn' ? station.severity : 'ok';
		if (row.el.dataset.sev !== sev) row.el.dataset.sev = sev;
		setText(row.value, `${value}${station.suffix || ''}`);
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

/** v2 の `overall` を正として、全面の色と状態語を決める。
 *
 *  v1 の `status` は承認待ちしか数えないので、**入力待ちのセッションを
 *  取りこぼす**（実測: サーバは needs-you なのに盤は「注意」と表示した）。
 *  判定はサーバ1箇所（契約 §2）なので、表示は `overall` に従う。
 *  色は前の見た目どおり3色に保つ: 要対応も異常も赤、語で区別する。 */
const OVERALL_TO_STATUS = {
	normal: 'ok',
	watch: 'warn',
	'needs-you': 'alert',
	alarm: 'alert',
};
const OVERALL_TO_WORD = {
	normal: '正常',
	watch: '注意',
	'needs-you': '要対応',
	alarm: '異常',
};

function render(state) {
	const now = Date.now();
	const overall = OVERALL_TO_STATUS[state.overall] || null;
	const status = overall || (state.status === 'warn' || state.status === 'alert' ? state.status : 'ok');
	const word = OVERALL_TO_WORD[state.overall] || STATUS_WORD[status];
	const alerts = state.alerts || [];

	// The colour field. This line is the alarm.
	if (refs.board.dataset.status !== status) refs.board.dataset.status = status;

	setText(refs.statusWord, word);
	// サーバの理由（「入力待ち 1件」など）があればそれを出す。無ければ v1 の内訳。
	// 理由行はサーバの reason を優先。無いときは v2 の数字から作る
	// （軽い形に v1 の `status` は無いので、statusSubline は使えない）。
	setText(refs.statusSub, state.reason ? state.reason : calmLine(state));
	// 右の大きな数字は「いま人が動くべき件数」。v1 は alerts.length（承認待ち・
	// ジョブ失敗）だが、v2 の needsYou は入力待ちも含むため、そのままだと
	// レールの「要対応 1」と大表示の「0 件」が並んで矛盾する。同じ値を使う。
	const needsYou =
		state.counts && typeof state.counts.needsYou === 'number' ? state.counts.needsYou : null;
	const bigNumber = needsYou !== null ? needsYou : alerts.length;
	setText(refs.alertCount, String(bigNumber));
	refs.counter.dataset.sev = bigNumber ? 'alert' : 'ok';

	renderWho(state);
	renderStations(buildStations(state));
	renderTicker([], logAsActivity(state.log, state.overall));

	lastGoodAt = now;
	// 軽い形（v2）には profile も uptime も無い。推測で出さない代わりに、
	// 「いつ時点の情報か」を出す。フリーズ検知の役目も兼ねる。
	setText(refs.host, lastGoodAt ? `最終受信 ${fmtDur(now - lastGoodAt)}前` : '—');

	const notes = state.notes || [];
	if (notes.length) {
		refs.notes.textContent = clampText(`取得できない項目: ${notes.join(' / ')}`, 120);
		refs.notes.hidden = false;
	} else {
		refs.notes.hidden = true;
	}

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