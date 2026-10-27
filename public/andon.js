/* dsh-andon / andon.js — the wall board's renderer.
 *
 * Contract: DESIGN.md §3.1 and §5. The whole shell (rail labels, field,
 * sessions list) is already in andon.html; this file only patches values in and
 * reuses nodes, so nothing flickers on a 2-second poll.
 *
 * Three zones, three jobs:
 *   rail   — the eight stations, numbered; a calling station lights solid
 *   field  — the colour (status) and the two numbers you read across a room
 *   sessions — every live session and its state (正常/権限/質問/停止)
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

/** 値が変わったときだけ書き込む（2秒ポーリングで毎回 DOM を触らない）。 */
function setText(node, text) {
	if (!node) return;
	const value = text === null || text === undefined ? '—' : String(text);
	if (node.textContent !== value) node.textContent = value;
}

const STATION_IDS = ['needs-you', 'running', 'context', 'errors'];

const refs = {
	board: $('board'),
	statusWord: $('status-word'),
	statusSub: $('status-sub'),
	sessions: $('status-sessions'),
	fs: $('fs'),
	counter: $('counter'),
	alertCount: $('alert-count'),
	host: $('host'),
	clock: $('clock'),
	conn: $('conn'),
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
/* 盤が画面からはみ出していたら、中身を段階的に詰める。
 *
 * 高さの報告値が端末によって嘘をつく（URL バー込みで返す）ことがあり、
 * 測って CSS に入れるだけでは直らなかった。ここでは**結果**を見る:
 * 盤の下端が実際の表示領域を超えていたら、ログの行を落とし、余白と文字を
 * 詰めて、超えなくなるまで最大3段階で縮める。原因が何であれ「切れない」に
 * 寄せるための最後の砦。 */
/* `?compact=1|2|3` で詰め方を手動指定できる（`?compact=0` で解除）。
 *
 * 自動判定が外れる端末（ブラウザの高さ報告が嘘をつく等）でも、本人が
 * 「この詰め方でいい」と決められるようにするための逃げ道。指定は
 * localStorage に残すので、次に開いたときも同じ詰め方になる。
 * 自動判定より手動指定を優先する（本人の目が一番確か）。 */
function manualCompact() {
	const raw = String(location.search);
	const found = /[?&]compact=([0-3])/.exec(raw);
	let level = null;
	if (found) {
		level = Number(found[1]);
		try {
			if (level) localStorage.setItem('andon:compact', String(level));
			else localStorage.removeItem('andon:compact');
		} catch {
			/* 保存できない環境ではその場の指定だけ効く */
		}
		return level;
	}
	try {
		const saved = Number(localStorage.getItem('andon:compact'));
		return saved >= 1 && saved <= 3 ? saved : null;
	} catch {
		return null;
	}
}
function fitContent() {
	const board = refs.board;
	if (!board) return;
	const manual = manualCompact();
	if (manual) {
		document.body.dataset.compact = String(manual);
		return;
	}
	document.body.removeAttribute('data-compact');
	/* 盤の外側ではなく「盤の中」が溢れているかを見る。盤は4辺で画面に
	 * 留まっているので、はみ出しは必ず中身の側で起きる。ブラウザが申告する
	 * 高さ（innerHeight / visualViewport / dvh）は端末によって嘘をつくため、
	 * 比較に使わない。 */
	for (let step = 1; step <= 3; step += 1) {
		if (board.scrollHeight <= board.clientHeight + 1) return;
		document.body.dataset.compact = String(step);
	}
}

function fitViewport() {
	fitContent();
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
	const line = () => {
		const box = board ? board.getBoundingClientRect() : { height: 0, bottom: 0 };
			return [
			`inner=${window.innerHeight}`,
			`vv=${view && view.height ? Math.round(view.height) : 'none'}`,
			`doc=${document.documentElement.clientHeight}`,
			`board=${Math.round(box.height)}`,
			`boardBottom=${Math.round(box.bottom)}`,
			// レールの点灯が実機で消えることがある（色の宣言が環境で落ちる）。
			// 状態と実際に塗られた色を並べて出す: 「点いているつもり」を防ぐ。
			`ctx=${document.querySelector('#st-context') ? document.querySelector('#st-context').dataset.sev : '?'}`,
			`ctxbg=${document.querySelector('#st-context .sr-v') ? getComputedStyle(document.querySelector('#st-context .sr-v')).backgroundColor : '?'}`,
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


function calmLine(state) {
	const c = state.counts || {};
	const running = typeof c.running === 'number' ? c.running : 0;
	const sessions = typeof c.sessions === 'number' ? c.sessions : 0;
	return `異常なし · 作業中 ${running} · 会話 ${sessions}`;
}
/** レール4局を、v2 の細い形（counts）から組み立てる。
 *
 *  8局あったが、常時 0 で、0 のときに何も起きない数字（セッション・ジョブ・
 *  サブ・目標）は落とした。意味の分からない数字が並ぶ板は、読む前に
 *  「読まなくていい」と判断される。残したのは4つだけ:
 *
 *    要対応  人が動く番（承認待ち・入力待ち）
 *    作業中  DSH がいま動かしている数
 *    記憶    会話の記憶がどれだけ埋まっているか（%）
 *    異常    壊れている数（失敗・起動失敗・診断・止まった目標）
 *
 *  サーバは counts を今も全部返す（API は変えない）。戻したくなったら
 *  ここに1行足して HTML に .sr を1つ戻すだけでよい。 */
function buildStations(state) {
	const c = state.counts || {};
	const n = (key) => (typeof c[key] === 'number' ? c[key] : null);
	const sum = (keys) => {
		let total = 0;
		let known = false;
		for (const key of keys) {
			const v = n(key);
			if (v !== null) {
				total += v;
				known = true;
			}
		}
		return known ? total : null;
	};
	const contextMax = n('contextMax');
	// errors は失敗ジョブ・起動失敗・診断の合計。目標の停止は別枠なので足す。
	const trouble = sum(['errors', 'goalsBlocked', 'goalsPaused']);
	const parts = [];
	if (n('jobsFailed')) parts.push(`失敗ジョブ ${n('jobsFailed')}`);
	if (n('goalsBlocked')) parts.push(`目標遮断 ${n('goalsBlocked')}`);
	if (n('goalsPaused')) parts.push(`目標休止 ${n('goalsPaused')}`);
	return [
		{
			id: 'needs-you',
			label: '要対応',
			value: c.needsYou || 0,
			suffix: '',
			hint: c.needsYou ? `承認・入力待ち ${c.needsYou}` : '人が動く番ではない',
			severity: c.needsYou > 0 ? 'alert' : 'ok',
		},
		{ id: 'running', label: '作業中', value: c.running || 0, suffix: '', hint: '動いているエージェント', severity: 'ok' },
		{
			id: 'context',
			label: '記憶',
			value: contextMax === null ? '—' : contextMax,
			suffix: contextMax === null ? '' : '%',
			hint: '会話の記憶の埋まり具合',
			severity: contextMax >= 90 ? 'alert' : contextMax >= 75 ? 'warn' : 'ok',
		},
		{
			id: 'errors',
			label: '異常',
			value: trouble === null ? '—' : trouble,
			suffix: '',
			hint: parts.length ? parts.join(' / ') : '壊れているものは無い',
			severity: trouble > 0 ? 'alert' : 'ok',
		},
	];
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
		// 0 と「動いている数」を同じ濃さで並べると、8工程が全部同じ強さで
		// 目に入る（盤の原則は「正常は静かに」）。色ではなく濃さと太さで
		// 分けるための印。寸法は変えない（値が 0↔1 で行が跳ねると読めない）。
		const empty = Number(value) === 0 ? '1' : '0';
		if (row.el.dataset.zero !== empty) row.el.dataset.zero = empty;
		setText(row.value, `${value}${station.suffix || ''}`);
		// The breakdown stays a tooltip: the rail is a glance, and the field
		// sub-line already states the categories in words.
		row.el.title = `${station.label}: ${station.hint || ''}`;
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
/** 盤に出す4語。サーバの `label` が正（CONTRACT-v2 §1 の判定とは別軸）。
 *  注意（watch）という語は持たない: 語を増やすと「どれを先にやるか」を
 *  読み手に考えさせる。無反応も文脈逼迫も「正常」に丸め、数字と理由だけ残す。 */
const LABEL_WORD = {
	normal: '正常',
	approval: '権限',
	question: '質問',
	stopped: '停止',
};
/** 語に対応する盤の色（3色しかない: 緑/黄/赤）。質問も黄 — どちらも
 *  「人が答えるまで進まない」同じ種類の待ちなので、色を分ける理由がない。 */
const LABEL_COLOR = {
	normal: 'ok',
	approval: 'warn',
	question: 'warn',
	stopped: 'alert',
};

/** 動いているセッションを全部出す。状態は4語（正常/権限/質問/停止）で色分け、
 *  待ちと停止には「いつから」を添える。
 *
 *  なぜ全部か: 盤の仕事は「どこが詰まっているか」ではなく「いま何がどう動いて
 *  いるか」を見せること。問題の3件だけ出すと、残りが止まっているのか
 *  動いているのか分からない。並びは 停止→権限→質問→正常（人が動く順）。 */
const SESSION_ORDER = { stopped: 0, approval: 1, question: 2, normal: 3 };
const SESSION_MAX = 8;

function elapsedJa(ms) {
	const min = Math.floor(ms / 60000);
	if (min < 1) return 'たった今';
	if (min < 60) return `${min}分前から`;
	const hours = Math.floor(min / 60);
	if (hours < 24) return `${hours}時間前から`;
	const d = new Date(ms);
	const mm = d.getMinutes() < 10 ? `0${d.getMinutes()}` : String(d.getMinutes());
	return `${d.getHours()}:${mm}から`;
}

/** 待ちの古さ。3分未満は地味、10分超は赤（文字色だけ。面は塗らない）。 */
function waitHeat(label, ageMs) {
	if (label !== 'approval' && label !== 'question') return 'none';
	if (ageMs >= 600000) return 'hot';
	if (ageMs >= 180000) return 'warm';
	return 'none';
}

function renderSessions(state) {
	const host = refs.sessions;
	if (!host) return;
	const rows = (state.sessions || []).map((s) => ({
		id: s.id,
		name: s.name || s.id || '',
		label: LABEL_WORD[s.label] ? s.label : 'normal',
		since: typeof s.since === 'number' ? s.since : null,
		reason: s.reason || '',
	}));
	rows.sort((a, b) => (SESSION_ORDER[a.label] - SESSION_ORDER[b.label]) || String(a.name).localeCompare(String(b.name)));
	clear(host);
	if (!rows.length) {
		const li = h('li', { class: 'sx', dataset: { label: 'normal', heat: 'none' } });
		li.appendChild(h('span', { class: 'sx-dot' }));
		li.appendChild(h('span', { class: 'sx-name', text: 'セッションなし' }));
		host.appendChild(li);
		return;
	}
	const now = Date.now();
	for (const row of rows.slice(0, SESSION_MAX)) {
		const age = row.since === null ? 0 : Math.max(0, now - row.since);
		const li = h('li', { class: 'sx', dataset: { label: row.label, heat: waitHeat(row.label, age) } });
		li.appendChild(h('span', { class: 'sx-dot' }));
		li.appendChild(h('span', { class: 'sx-name', text: clampText(row.name, 34) }));
		li.appendChild(h('span', { class: 'sx-why', text: row.label === 'normal' ? '' : clampText(row.reason, 22) }));
		li.appendChild(h('span', { class: 'sx-age', text: row.label === 'normal' ? '' : elapsedJa(row.since === null ? now : row.since) }));
		host.appendChild(li);
	}
	if (rows.length > SESSION_MAX) {
		const li = h('li', { class: 'sx sx-more', dataset: { label: 'normal', heat: 'none' } });
		li.appendChild(h('span', { class: 'sx-name', text: `他 ${rows.length - SESSION_MAX}件` }));
		host.appendChild(li);
	}
}

/** サーバが `label` を返さない間の後方互換。
 *
 *  判定（state/overall）→ 盤の語（normal/approval/question/stopped）への写像を
 *  1箇所に持つ。サーバが label を返すようになったら、その値をそのまま使う
 *  （ここは素通りする）。判定基準は lib/state.js の judgeOne と同じ:
 *
 *    reason に「エラーで停止」「停止したまま」→ stopped
 *    reason に「承認待ち」→ approval / 「入力待ち」→ question
 *    それ以外の needs-you（放置・文脈）→ approval 扱い（人が何かする）
 *    watch（無反応・文脈80%）は normal に丸める（盤の語を増やさない） */
function labelOfSession(session) {
	if (session.label) return session.label;
	const reason = String(session.reason || '');
	const state = String(session.state || '');
	if (reason.indexOf('エラー') > -1 || reason.indexOf('停止') > -1) return 'stopped';
	if (state === 'needs-you' || state === 'alarm') {
		if (reason.indexOf('承認') > -1) return 'approval';
		if (reason.indexOf('入力') > -1 || reason.indexOf('質問') > -1) return 'question';
		return 'approval';
	}
	return 'normal';
}

function withLabels(state) {
	if (!state || typeof state !== 'object') return state;
	const sessions = Array.isArray(state.sessions) ? state.sessions : null;
	if (!sessions) return state;
	let changed = false;
	const next = sessions.map((s) => {
		if (s && s.label) return s;
		changed = true;
		return Object.assign({}, s, { label: labelOfSession(s || {}) });
	});
	if (!state.label) {
		const order = { normal: 0, approval: 1, question: 1, stopped: 2 };
		let worst = 'normal';
		for (const s of next) {
			if ((order[s.label] || 0) > (order[worst] || 0)) worst = s.label;
		}
		changed = true;
		return Object.assign({}, state, { sessions: next, label: worst });
	}
	return changed ? Object.assign({}, state, { sessions: next }) : state;
}

function render(state) {
	const now = Date.now();
	const label = LABEL_WORD[state.label] ? state.label : 'normal';
	const overall = LABEL_COLOR[label] || null;
	const status = overall || (state.status === 'warn' || state.status === 'alert' ? state.status : 'ok');
	const word = LABEL_WORD[label];
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

	renderSessions(state);
	renderStations(buildStations(state));


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
	fitContent();
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
	onData: (raw) => {
		const state = withLabels(raw);
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