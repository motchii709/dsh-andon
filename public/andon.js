/* dsh-andon / andon.js — 盤の描画と通信。
 *
 * 契約は docs/CONTRACT-v2.md。ここに書いていない形は読まない。
 *
 *   スナップショット  { v, serverTime, seq, build, overall, reason, counts, sessions[], log[], history[] }
 *   状態               normal / watch / needs-you / alarm / offline（offline だけクライアント判定）
 *   null の項目        lastOutputAt / contextPct / runningSince は「取得不可」。0 で埋めない
 *
 * 画面（§3）
 *   正常・注意  暗背景＋セッション一覧（1行1セッション、最低12行、あふれは「他N件」）
 *   要対応      橙の全画面＋カード（最大3枚、確認ボタンは Space）
 *   異常        赤の全画面＋点滅
 *   通信断      灰の全画面。通信断／最終受信／再接続中 以外を出さない
 *
 * 制約: ES2015 まで。`?.` `??` async/await padStart Object.entries `**`
 * 数値セパレータは禁止（Fire タブの古い Silk が解析できない）。
 * そのため fetch は promise チェーンで書き、AbortController は typeof で検出する。
 */

import { clampText, clear, fmtClock, h } from './board.js';

const $ = (id) => document.getElementById(id);

const STATE_URL = '/api/andon/state';
const ACK_URL = '/api/andon/ack';

const OFFLINE_MS = 6000; // 最終受信からこれだけ経ったら通信断
const OFFLINE_SOUND_MS = 10000; // 通信断の音は10秒続いてから
const RECOVER_HITS = 3; // 復帰は3回受信してから（1回で戻すとちらつく）
const POLL_MS = 2000; // 正常時のポーリング間隔
const MAX_BACKOFF_MS = 15000; // 再接続の上限
const FETCH_TIMEOUT_MS = 8000;
const TICK_MS = 1000; // 「最終受信 ○秒前」と経過表示
const OFFLINE_TICK_MS = 250; // 通信断の判定
const LIST_MIN_ROWS = 12; // 一覧の最低行数（入る限り出す）
const MAX_CARDS = 3; // 要対応・異常のカード枚数
const NAME_MAX = 40; // 表示の切り詰め: セッション名もログ本文も … 込みで40文字
const LOG_MAX = 24;
const NA = '取得不可';

const STATE = {
	normal: { sym: '○', name: '正常', rank: 3 },
	watch: { sym: '△', name: '注意', rank: 2 },
	'needs-you': { sym: '◆', name: '要対応', rank: 1 },
	alarm: { sym: '✕', name: '異常', rank: 0 },
	offline: { sym: '？', name: '通信断', rank: -1 },
};

const refs = {
	app: $('app'),
	sym: $('hdr-sym'),
	name: $('hdr-name'),
	reason: $('hdr-reason'),
	mNeedsYou: $('m-needsyou'),
	vNeedsYou: $('mv-needsyou'),
	mRunning: $('m-running'),
	vRunning: $('mv-running'),
	vCtx: $('mv-ctx'),
	sCtx: $('ms-ctx'),
	recv: $('recv'),
	now: $('now'),
	sound: $('btn-sound'),
	list: $('view-list'),
	rows: $('rows'),
	listMore: $('list-more'),
	cardsView: $('view-cards'),
	cards: $('cards'),
	cardsMore: $('cards-more'),
	offlineView: $('view-offline'),
	offLast: $('off-last'),
	offRetry: $('off-retry'),
	detail: $('view-detail'),
	detBody: $('det-body'),
	log: $('log'),
	hist: $('hist'),
};

/* ── 小物 ────────────────────────────────────────────────────────────────── */

function pad2(n) {
	return n < 10 ? '0' + n : String(n);
}

function setText(node, text) {
	const next = String(text);
	if (node.textContent !== next) node.textContent = next;
}

function stateOf(value) {
	return STATE[value] ? value : 'normal';
}

function metaOf(value) {
	return STATE[value] || STATE.normal;
}

/** 数字として使える値だけを数値にする。無ければ null。 */
function num(value) {
	return typeof value === 'number' && isFinite(value) ? value : null;
}

/** 経過。秒 → 分 → 時間。カードでは秒が回る（「経過（秒更新）」）。 */
function fmtElapsed(ms) {
	const sec = Math.max(0, Math.floor(ms / 1000));
	if (sec < 60) return sec + '秒';
	const min = Math.floor(sec / 60);
	if (min < 60) return sec % 60 === 0 ? min + '分' : min + '分' + pad2(sec % 60) + '秒';
	const hour = Math.floor(min / 60);
	if (hour < 24) return hour + '時間' + pad2(min % 60) + '分';
	return Math.floor(hour / 24) + '日' + pad2(hour % 24) + '時間';
}

/** 「最終受信 ○秒前」。 */
function fmtAgo(ms) {
	const sec = Math.max(0, Math.floor(ms / 1000));
	if (sec < 1) return 'たった今';
	if (sec < 60) return sec + '秒前';
	return Math.floor(sec / 60) + '分' + pad2(sec % 60) + '秒前';
}

function nameOf(session) {
	const raw = typeof session.name === 'string' && session.name ? session.name : session.id;
	return clampText(String(raw || ''), NAME_MAX);
}

/* ── 状態の器 ───────────────────────────────────────────────────────────── */

let model = null; // 正規化したスナップショット
let offset = 0; // serverTime - Date.now()
let lastAt = 0; // 最後に受信した端末時刻
let attempts = 0; // 連続失敗回数（再接続中（試行N回目））
let lastSeq = null;
let lastBuild = '';
let offline = true; // 起動直後はまだ何も来ていない＝通信断と同じ扱い
let acked = null; // { overall, needsYou } 確認済みの警報
let nightOverride = null; // ?night=0 / ?night=1
let tickers = []; // 1秒ごとに更新する経過表示
let detailOpen = false;
let forcedRefreshAt = 0;

function serverNow() {
	return Date.now() + offset;
}

function receivedAge() {
	return lastAt ? Date.now() - lastAt : null;
}

/* ?night=0 / ?night=1 / ?detail=1 は撮影と点検のための上書き。既定は 22:00〜6:00。 */
function readQuery() {
	const search = String(location.search || '');
	const m = /[?&]night=([01])/.exec(search);
	if (m) nightOverride = m[1] === '1';
	if (/[?&]detail=1/.test(search)) detailOpen = true;
}

function isNight() {
	if (nightOverride !== null) return nightOverride;
	const hour = new Date(serverNow()).getHours();
	return hour >= 22 || hour < 6;
}

/* ── ペイロードの正規化 ─────────────────────────────────────────────────── */

/**
 * v2 をそのまま読む。v2 が来る前のプレビュー（schema 1）でも画面が空にならない
 * ように、旧 `cards` / `alerts` / `activity` から「描ける範囲だけ」を組む。
 * サーバが v2 を返し始めたら normalizeLegacy は不要。
 */
function normalize(raw) {
	if (!raw || typeof raw !== 'object') return null;
	if (Array.isArray(raw.sessions)) {
		return {
			overall: stateOf(raw.overall),
			reason: typeof raw.reason === 'string' ? raw.reason : '',
			counts: raw.counts && typeof raw.counts === 'object' ? raw.counts : {},
			sessions: raw.sessions,
			log: Array.isArray(raw.log) ? raw.log : [],
			history: Array.isArray(raw.history) ? raw.history : [],
			seq: num(raw.seq),
			build: typeof raw.build === 'string' ? raw.build : '',
		};
	}
	return normalizeLegacy(raw);
}

function legacyState(card) {
	const label = String((card && card.statusLabel) || '');
	if (label.indexOf('承認待ち') !== -1 || label.indexOf('入力待ち') !== -1) return 'needs-you';
	if (card && card.severity === 'alert') return 'alarm';
	if (card && card.severity === 'warn') return 'watch';
	return 'normal';
}

/** schema 1（v2 以前）のペイロードから、v2 と同じ形の最小限を組む。 */
function normalizeLegacy(raw) {
	const counts = raw.counts || {};
	const cards = Array.isArray(raw.cards) ? raw.cards : [];
	const sessions = [];
	for (let i = 0; i < cards.length; i += 1) {
		const card = cards[i];
		const detail = card.detail || {};
		sessions.push({
			id: card.id || 'card-' + i,
			name: card.title || card.subtitle || card.id || '',
			status: card.column === 'running' ? 'running' : 'idle',
			state: legacyState(card),
			reason: card.statusLabel && card.statusLabel !== '実行中' ? card.statusLabel : '',
			since: num(card.since),
			runningSince: num(detail.startedAt),
			lastOutputAt: num(card.updatedAt),
			contextPct: null,
		});
	}
	const log = [];
	const alerts = Array.isArray(raw.alerts) ? raw.alerts : [];
	for (let i = 0; i < alerts.length; i += 1) {
		log.push({
			at: num(alerts[i].since),
			session: alerts[i].sessionTitle || '',
			severity: alerts[i].severity === 'alert' ? 'alert' : 'warn',
			text: alerts[i].title || '',
		});
	}
	const activity = Array.isArray(raw.activity) ? raw.activity : [];
	for (let i = 0; i < activity.length; i += 1) {
		const item = activity[i];
		const repeat = Number(item.count) > 1 ? ' ×' + item.count : '';
		log.push({
			at: num(item.at),
			session: item.session || '',
			severity: item.severity === 'alert' ? 'alert' : item.severity === 'warn' ? 'warn' : 'ok',
			text: (item.text || '') + repeat,
		});
	}
	log.sort((a, b) => (num(b.at) || 0) - (num(a.at) || 0));
	return {
		overall: raw.status === 'alert' ? 'alarm' : raw.status === 'warn' ? 'watch' : 'normal',
		reason: '',
		counts: {
			needsYou: (counts.pendingApprovals || 0) + (counts.pendingQuestions || 0),
			running: counts.agentsRunning || 0,
			contextMax: null,
			jobs: counts.jobsFailed,
			subagents: counts.subagentsRunning,
			goals: counts.goalsBlocked,
		},
		sessions,
		log,
		history: [],
		seq: null,
		build: '',
	};
}

/* ── 並び ───────────────────────────────────────────────────────────────── */

function rankOf(state) {
	return STATE[state] ? STATE[state].rank : 3;
}

/** 悪い順。同じ状態ならコンテキストの多い順、次に最終出力の古い順。 */
function sorted(sessions) {
	const out = sessions.slice();
	out.sort((a, b) => {
		const byRank = rankOf(a.state) - rankOf(b.state);
		if (byRank !== 0) return byRank;
		const ca = num(a.contextPct);
		const cb = num(b.contextPct);
		if (ca !== cb && ca !== null && cb !== null) return cb - ca;
		if (ca === null && cb !== null) return 1;
		if (cb === null && ca !== null) return -1;
		const la = num(a.lastOutputAt);
		const lb = num(b.lastOutputAt);
		if (la !== lb && la !== null && lb !== null) return la - lb;
		if (la === null && lb !== null) return 1;
		if (lb === null && la !== null) return -1;
		return 0;
	});
	return out;
}

/* ── はみ出しの処理 ─────────────────────────────────────────────────────── */

/**
 * 入るだけ出して、残りは「他N件」に畳む。行の高さは状態で変わるので
 * 実際の高さで測る（1行だけ隠して測り直す、を繰り返す）。
 */
function trimToFit(container, rows, moreNode) {
	for (let i = 0; i < rows.length; i += 1) rows[i].hidden = false;
	if (moreNode) moreNode.hidden = true;
	if (!rows.length) return 0;
	const overflow = () => container.scrollHeight > container.clientHeight + 1;
	let shown = rows.length;
	if (!overflow()) return shown;
	if (moreNode) moreNode.hidden = false;
	while (shown > 1 && overflow()) {
		shown -= 1;
		rows[shown].hidden = true;
	}
	return shown;
}

/* ── ヘッダ ─────────────────────────────────────────────────────────────── */

function renderHeader() {
	const meta = metaOf(model.overall);
	setText(refs.sym, meta.sym);
	setText(refs.name, meta.name);

	const reason = model.reason && model.overall !== 'normal' ? model.reason : '';
	refs.reason.hidden = !reason;
	if (reason) setText(refs.reason, reason);

	// 指標は3つだけ。要対応 / 実行中 / コンテキスト最大（セッション名付き）。
	const needsYou = num(model.counts.needsYou);
	const running = num(model.counts.running);
	setText(refs.vNeedsYou, needsYou === null ? '—' : String(needsYou));
	setText(refs.vRunning, running === null ? '—' : String(running));
	refs.mNeedsYou.dataset.zero = needsYou === 0 ? '1' : '0';
	refs.mRunning.dataset.zero = running === 0 ? '1' : '0';

	// コンテキスト最大は契約の counts.contextMax。無ければ最も重いセッションから。
	let ctxMax = num(model.counts.contextMax);
	let ctxName = '';
	const worst = contextLeader();
	if (ctxMax === null && worst) ctxMax = num(worst.contextPct);
	if (worst && num(worst.contextPct) !== null) ctxName = nameOf(worst);
	setText(refs.vCtx, ctxMax === null ? NA : ctxMax + '%');
	refs.vCtx.dataset.na = ctxMax === null ? '1' : '0';
	setText(refs.sCtx, ctxName);
	refs.sCtx.dataset.zero = ctxMax === 0 ? '1' : '0';
}

function contextLeader() {
	let best = null;
	let bestPct = -1;
	for (let i = 0; i < model.sessions.length; i += 1) {
		const pct = num(model.sessions[i].contextPct);
		if (pct !== null && pct > bestPct) {
			bestPct = pct;
			best = model.sessions[i];
		}
	}
	return best;
}

function paintClock() {
	const age = receivedAge();
	setText(refs.recv, age === null ? '最終受信 —' : '最終受信 ' + fmtAgo(age));
	refs.recv.dataset.stale = age === null || age > 4000 ? '1' : '0';
	setText(refs.now, fmtClock(serverNow()));
}

/* ── 一覧（正常・注意）──────────────────────────────────────────────────── */

function elapsedNode(from, cls) {
	const node = h('span', { class: cls });
	if (from === null) {
		node.textContent = NA;
		node.dataset.na = '1';
	} else {
		node.textContent = fmtElapsed(Math.max(0, serverNow() - from));
		tickers.push({ node, from });
	}
	return node;
}

function renderList() {
	clear(refs.rows);
	refs.listMore.hidden = true;
	const list = sorted(model.sessions);
	const rows = [];
	if (!list.length) {
		refs.rows.appendChild(h('p', { class: 'empty', text: 'セッションなし' }));
		return;
	}
	for (let i = 0; i < list.length; i += 1) {
		const session = list[i];
		const pct = num(session.contextPct);
		const bar = h('span', { class: 'ctxbar' }, h('i'));
		if (pct !== null) {
			bar.firstChild.style.width = Math.max(0, Math.min(100, pct)) + '%';
			bar.dataset.zero = pct === 0 ? '1' : '0';
		} else {
			bar.firstChild.style.width = '0%';
			bar.dataset.na = '1';
		}
		const pctNode = h('span', { class: 'c-ctxv' });
		if (pct === null) {
			pctNode.textContent = NA;
			pctNode.dataset.na = '1';
		} else {
			pctNode.textContent = pct + '%';
		}
		const row = h(
			'div',
			{ class: 'row', dataset: { st: stateOf(session.state) } },
			h('span', { class: 'c-name', text: nameOf(session) }),
			h('span', { class: 'c-st', text: metaOf(session.state).sym + ' ' + metaOf(session.state).name }),
			elapsedNode(num(session.runningSince), 'c-run'),
			elapsedNode(num(session.lastOutputAt), 'c-out'),
			h('span', { class: 'c-ctx' }, bar, pctNode),
		);
		rows.push(row);
		refs.rows.appendChild(row);
	}
	const shown = trimToFit(refs.rows, rows, refs.listMore);
	if (shown < rows.length) {
		refs.listMore.hidden = false;
		setText(refs.listMore, '他' + (rows.length - shown) + '件');
	}
}

/* ── カード（要対応・異常）────────────────────────────────────────────── */

/** 直近出力の1行。契約 v2 の `sessions[].lastOutput`（最終出力1行・無ければ null）。
 *  まだ null のあいだは 取得不可。ログから推測して埋めない。 */
function latestOutputOf(session) {
	const text = session.lastOutput;
	if (typeof text !== 'string' || !text) return '';
	return clampText(text, NAME_MAX);
}

function renderCards() {
	clear(refs.cards);
	refs.cardsMore.hidden = true;
	const targets = sorted(model.sessions).filter(
		(session) => session.state === 'needs-you' || session.state === 'alarm',
	);
	const pool = targets.length ? targets : sorted(model.sessions);
	const shown = pool.slice(0, MAX_CARDS);

	for (let i = 0; i < shown.length; i += 1) {
		const session = shown[i];
		// カードの経過は `since`（この状態になった時刻）。実行経過（runningSince）
		// とは別物なので、ラベルで取り違えないようにする。
		const since = num(session.since);
		const output = latestOutputOf(session);
		const reason =
			typeof session.reason === 'string' && session.reason
				? session.reason
				: metaOf(session.state).name;
		const when = h('p', { class: 'card-when' }, 'この状態になって ');
		if (since === null) {
			when.appendChild(h('span', { class: 'when-v', text: NA, dataset: { na: '1' } }));
		} else {
			when.appendChild(elapsedNode(since, 'when-v'));
		}
		const card = h(
			'div',
			{ class: 'card', dataset: { st: stateOf(session.state) } },
			h('p', { class: 'card-name', text: nameOf(session) }),
			h('p', { class: 'card-reason', text: clampText(reason, 30) }),
			when,
			h('p', {
				class: 'card-out',
				text: output ? '直近の出力: ' + output : '直近の出力: ' + NA,
			}),
			h('button', { class: 'ack', type: 'button', onclick: ack }, '確認'),
		);
		refs.cards.appendChild(card);
	}

	if (pool.length > shown.length) {
		refs.cardsMore.hidden = false;
		setText(refs.cardsMore, '他' + (pool.length - shown.length) + '件');
	}
}

/* ── ログ ───────────────────────────────────────────────────────────────── */

function renderLog() {
	clear(refs.log);
	const log = model.log;
	const rows = [];
	if (!log.length) {
		refs.log.appendChild(h('p', { class: 'empty', text: '記録なし' }));
		return;
	}
	const limit = Math.min(log.length, LOG_MAX);
	for (let i = 0; i < limit; i += 1) {
		const entry = log[i] || {};
		const severity = entry.severity === 'alert' ? 'alert' : entry.severity === 'warn' ? 'warn' : 'ok';
		const at = num(entry.at);
		const row = h(
			'li',
			{ class: 'lrow', dataset: { sev: severity } },
			h('span', { class: 'lt', text: at === null ? '—' : fmtClock(at + offset) }),
			h('span', {
				class: 'ln',
				text: entry.session ? '[' + clampText(String(entry.session), NAME_MAX) + ']' : '',
			}),
			// ログ本文も40文字で切る（… 込みで40文字）。
			h('span', { class: 'ltx', text: clampText(String(entry.text || ''), NAME_MAX) }),
		);
		// 新しい行ほど濃く、古い行ほど薄く。下限 0.6 は 4.5:1 を割らないため。
		row.style.opacity = String(Math.max(0.6, 1 - i * 0.05));
		rows.push(row);
		refs.log.appendChild(row);
	}
	trimToFit(refs.log, rows, null);
}

/* ── 履歴帯 ─────────────────────────────────────────────────────────────── */

const HIST_SLOTS = 1440; // 24時間を1分粒度で
const HIST_SLOT_MS = 60000;
const HIST_EDGE_MIN = 24; // 「いま」の区画は最低これだけの幅を確保する（8px では見えなかった）

/** 履歴帯の色。正常は緑を使わない — 緑を敷くと盤が緑っぽくなり、
 *  「正常は静か」が崩れる。記録の無い区間は正常より一段暗い灰（黒くはしない:
 *  黒一色の帯は「壊れている」ように見える）。夜は全体を沈める。 */
function histColor(state) {
	const night = isNight();
	if (state === 'alarm') return night ? '#6b1f22' : '#e5484d';
	if (state === 'needs-you' || state === 'watch') return night ? '#6b4d18' : '#e8a13a';
	if (state === 'normal') return night ? '#262c31' : '#3a4248';
	return night ? '#1e2429' : '#2c3237';
}

function renderHistory() {
	const canvas = refs.hist;
	const width = canvas.clientWidth;
	const height = canvas.clientHeight;
	if (!width || !height) return;
	const ratio = window.devicePixelRatio || 1;
	const pxWidth = Math.round(width * ratio);
	const pxHeight = Math.round(height * ratio);
	if (canvas.width !== pxWidth || canvas.height !== pxHeight) {
		canvas.width = pxWidth;
		canvas.height = pxHeight;
	}
	const ctx = canvas.getContext ? canvas.getContext('2d') : null;
	if (!ctx) return;
	ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
	ctx.clearRect(0, 0, width, height);

	const entries = model.history.slice();
	entries.sort((a, b) => (num(a && a.at) || 0) - (num(b && b.at) || 0));
	const now = serverNow();
	const start = now - HIST_SLOTS * HIST_SLOT_MS;
	const lastAt = entries.length ? num(entries[entries.length - 1].at) : null;
	let cursor = 0;
	let current = 'unknown';
	for (let i = 0; i < HIST_SLOTS; i += 1) {
		const edge = start + (i + 1) * HIST_SLOT_MS;
		while (cursor < entries.length && (num(entries[cursor].at) || 0) <= edge) {
			current = stateOf(entries[cursor].state);
			cursor += 1;
		}
		// 最後の記録より先は「記録なし」。状態が続いていると決めつけるのは推測に
		// なる（§0）。ここを塗り伸ばすと、いまの overall と食い違って盤が嘘を
		// ついたように見える。
		const known = lastAt !== null && edge <= lastAt;
		const x0 = Math.floor((i * width) / HIST_SLOTS);
		const x1 = Math.floor(((i + 1) * width) / HIST_SLOTS);
		ctx.fillStyle = histColor(known ? current : 'unknown');
		ctx.fillRect(x0, 0, Math.max(1, x1 - x0), height);
	}

	// 右端（いま）は必ず現在の overall と同じ色にする。
	// 1分＝1px強なので、直近の記録が数秒前だと「いま」の色が見えない。
	// 最低幅を確保して、右端が必ず読めるようにする。
	if (lastAt !== null) {
		const from = Math.max(start, lastAt);
		const x = Math.floor(((from - start) / HIST_SLOT_MS) * (width / HIST_SLOTS));
		const edge = Math.min(Math.max(0, x), width - HIST_EDGE_MIN);
		ctx.fillStyle = histColor(model.overall);
		ctx.fillRect(edge, 0, width - edge, height);
	} else {
		ctx.fillStyle = histColor(model.overall);
		ctx.fillRect(width - HIST_EDGE_MIN, 0, HIST_EDGE_MIN, height);
	}
}

/* ── 詳細 ───────────────────────────────────────────────────────────────── */

function detailRow(label, value, zero) {
	const tr = h('tr');
	tr.appendChild(h('th', { text: label }));
	const td = h('td', { class: 'det-v' });
	if (value && value.node) {
		td.appendChild(value.node);
	} else {
		td.textContent = value === null || value === undefined ? NA : String(value);
		if (value === null || value === undefined) td.dataset.na = '1';
	}
	if (zero) td.dataset.zero = '1';
	tr.appendChild(td);
	return tr;
}

function renderDetail() {
	clear(refs.detBody);
	const counts = model.counts;
	const leader = contextLeader();
	const leaderPct = leader ? num(leader.contextPct) : null;
	const rows = [
		['全体', metaOf(model.overall).sym + ' ' + metaOf(model.overall).name, false],
		['理由', model.reason || '—', false],
		['要対応', num(counts.needsYou), num(counts.needsYou) === 0],
		['実行中', num(counts.running), num(counts.running) === 0],
		['セッション', model.sessions.length, model.sessions.length === 0],
		['ジョブ', num(counts.jobs), num(counts.jobs) === 0],
		['サブエージェント', num(counts.subagents), num(counts.subagents) === 0],
		['目標', num(counts.goals), num(counts.goals) === 0],
		[
			'コンテキスト最大',
			leaderPct === null ? null : leaderPct + '%／' + nameOf(leader),
			leaderPct === 0,
		],
		['seq', num(model.seq) === null ? null : model.seq, false],
		['build', model.build || null, false],
		['時刻補正', (offset >= 0 ? '+' : '') + offset + 'ms', false],
		['最終受信', receivedAge() === null ? null : fmtAgo(receivedAge()), false],
	];
	for (let i = 0; i < rows.length; i += 1) {
		refs.detBody.appendChild(detailRow(rows[i][0], rows[i][1], rows[i][2]));
	}
}

/* ── 画面の切り替え ─────────────────────────────────────────────────────── */

function setScreen(screen) {
	refs.offlineView.hidden = screen !== 'offline';
	refs.list.hidden = screen !== 'list';
	refs.cardsView.hidden = screen !== 'cards';
	refs.detail.hidden = screen !== 'detail';
	refs.app.dataset.view = screen === 'detail' ? 'detail' : 'main';
}

function render() {
	if (offline || !model) {
		renderOffline();
		return;
	}

	// 確認（ACK）で止めるのは点滅と音だけ。状態と色は残す。
	if (acked) {
		const needsYou = num(model.counts.needsYou) || 0;
		if (model.overall !== acked.overall || needsYou > acked.needsYou) acked = null;
	}
	refs.app.dataset.acked = acked ? '1' : '0';
	refs.app.dataset.overall = model.overall;
	refs.app.dataset.night = isNight() ? '1' : '0';

	renderHeader();
	paintClock();

	if (detailOpen) {
		setScreen('detail');
		renderDetail();
		return;
	}
	if (model.overall === 'needs-you' || model.overall === 'alarm') {
		setScreen('cards');
		renderCards();
	} else {
		setScreen('list');
		renderList();
	}

	renderLog();
	renderHistory();
	paintTickers();
	syncSound();
}

function renderOffline() {
	const age = receivedAge();
	refs.app.dataset.overall = 'offline';
	refs.app.dataset.night = isNight() ? '1' : '0';
	refs.app.dataset.acked = '0';
	// 詳細を開いていたかは覚えておく（復帰したら同じ画面へ戻す）。
	setScreen('offline');
	setText(refs.offLast, age === null ? '最終受信 —' : '最終受信 ' + fmtAgo(age));
	setText(refs.offRetry, attempts > 0 ? '再接続中（試行' + attempts + '回目）' : '再接続中');
	syncSound();
}

/** 経過表示だけを毎秒更新する（DOM は作り直さない）。 */
function paintTickers() {
	if (offline || !model) return;
	const now = serverNow();
	for (let i = 0; i < tickers.length; i += 1) {
		const item = tickers[i];
		setText(item.node, fmtElapsed(Math.max(0, now - item.from)));
	}
}

/* ── 通知（§6）────────────────────────────────────────────────────────── */

const sound = {
	enabled: false,
	muted: false,
	ctx: null,
	timer: null,
	lastAt: 0,
	chirpFor: '', // 直近に2音を鳴らした「要対応の内容」の識別子
	loopReason: '', // 反復中の理由（alarm / offline）
};

function audioContext() {
	if (sound.ctx) return sound.ctx;
	const Ctor = typeof AudioContext === 'function' ? AudioContext : window.webkitAudioContext;
	if (!Ctor) return null;
	sound.ctx = new Ctor();
	return sound.ctx;
}

/** 短い2音。要対応。 */
function playChirp() {
	const ctx = audioContext();
	if (!ctx) return;
	const at = ctx.currentTime;
	for (let i = 0; i < 2; i += 1) {
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.type = 'sine';
		osc.frequency.value = i === 0 ? 740 : 990;
		gain.gain.setValueAtTime(0.0001, at + i * 0.18);
		gain.gain.exponentialRampToValueAtTime(0.22, at + i * 0.18 + 0.02);
		gain.gain.exponentialRampToValueAtTime(0.0001, at + i * 0.18 + 0.16);
		osc.connect(gain);
		gain.connect(ctx.destination);
		osc.start(at + i * 0.18);
		osc.stop(at + i * 0.18 + 0.18);
	}
}

/** 強い音。異常・通信断。30秒間隔で確認まで繰り返す。 */
function playAlarm() {
	const ctx = audioContext();
	if (!ctx) return;
	const at = ctx.currentTime;
	for (let i = 0; i < 2; i += 1) {
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.type = 'square';
		osc.frequency.value = i === 0 ? 620 : 440;
		gain.gain.setValueAtTime(0.0001, at + i * 0.32);
		gain.gain.exponentialRampToValueAtTime(0.18, at + i * 0.32 + 0.02);
		gain.gain.exponentialRampToValueAtTime(0.0001, at + i * 0.32 + 0.3);
		osc.connect(gain);
		gain.connect(ctx.destination);
		osc.start(at + i * 0.32);
		osc.stop(at + i * 0.32 + 0.32);
	}
	sound.lastAt = Date.now();
}

function mutedNow() {
	if (sound.muted) return true;
	return isNight();
}

function soundLabel() {
	if (!sound.enabled) return '音: 無効';
	if (sound.muted) return '音: ミュート';
	if (isNight()) return '音: 夜間ミュート';
	return '音: 有効';
}

function syncSound() {
	setText(refs.sound, soundLabel());
}

/** 画面の状態に合わせて鳴らす／止める。連続再生はしない（30秒間隔が最短）。
 *
 *  要対応  短い2音を1回だけ（新しい要対応が出たとき）
 *  異常    強い音を確認（ACK）まで30秒間隔
 *  通信断  10秒続いたときだけ強い音を30秒間隔
 */
function syncAlertSound() {
	if (!sound.enabled || !model) return;
	if (mutedNow()) {
		stopSound();
		return;
	}

	if (offline) {
		const age = receivedAge();
		if (age === null || age < OFFLINE_SOUND_MS) return;
		startAlarmLoop('offline');
		return;
	}

	const alarmish = model.overall === 'alarm';
	const needsYou = model.overall === 'needs-you';

	if (alarmish) {
		if (acked) {
			stopSound();
			return;
		}
		startAlarmLoop('alarm');
		return;
	}

	stopSound();
	if (!needsYou || acked) return;

	// 2音は「新しい要対応が出たとき」に1回だけ。
	const needsYouCount = num(model.counts.needsYou) || 0;
	const stamp = model.overall + ':' + needsYouCount;
	if (sound.chirpFor === stamp) return;
	sound.chirpFor = stamp;
	playChirp();
}

/** 30秒間隔の反復。同じ理由で二重に鳴らさない。 */
function startAlarmLoop(reason) {
	if (sound.timer) {
		if (sound.loopReason === reason) return;
		stopSound();
	}
	sound.loopReason = reason;
	playAlarm();
	sound.timer = setInterval(() => {
		if (!sound.enabled || mutedNow()) return;
		if (reason === 'offline') {
			if (!offline) return;
			const age = receivedAge();
			if (age === null || age < OFFLINE_SOUND_MS) return;
			playAlarm();
			return;
		}
		if (!model || model.overall !== 'alarm' || acked || offline) return;
		playAlarm();
	}, 30000);
}

function stopSound() {
	if (sound.timer) {
		clearInterval(sound.timer);
		sound.timer = null;
	}
	sound.loopReason = '';
}

function onSoundButton() {
	if (!sound.enabled) {
		const ctx = audioContext();
		if (!ctx) {
			setText(refs.sound, '音: 非対応');
			return;
		}
		const resumed = ctx.resume ? ctx.resume() : null;
		if (resumed && resumed.then) resumed.then(() => {}).catch(() => {});
		sound.enabled = true;
		sound.muted = false;
		playChirp();
		syncSound();
		syncAlertSound();
		return;
	}
	sound.muted = !sound.muted;
	if (sound.muted) stopSound();
	syncSound();
	syncAlertSound();
}

/* ── 確認（ACK）───────────────────────────────────────────────────────── */

function deviceId() {
	try {
		const key = 'andon-device';
		let id = window.localStorage.getItem(key);
		if (!id) {
			id = 'dev-' + Math.random().toString(36).slice(2, 10);
			window.localStorage.setItem(key, id);
		}
		return id;
	} catch (error) {
		return 'dev-unknown';
	}
}

function postAck(body) {
	const init = {
		method: 'POST',
		cache: 'no-store',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	};
	fetch(ACK_URL, init)
		.then((res) => {
			if (!res.ok) console.warn('ack rejected', res.status);
		})
		.catch((error) => {
			console.warn('ack failed', error);
		});
}

/** 止まるのは点滅と音だけ。色と状態は残す。 */
function ack() {
	if (offline || !model) return;
	if (model.overall !== 'needs-you' && model.overall !== 'alarm') return;
	acked = { overall: model.overall, needsYou: num(model.counts.needsYou) || 0 };
	refs.app.dataset.acked = '1';
	stopSound();
	postAck({ seq: num(model.seq), overall: model.overall, device: deviceId() });
}

/* ── 通信 ───────────────────────────────────────────────────────────────── */

function fetchState() {
	const hasAbort = typeof AbortController === 'function';
	const controller = hasAbort ? new AbortController() : null;
	const init = { cache: 'no-store', headers: { accept: 'application/json' } };
	if (controller) init.signal = controller.signal;

	let settled = false;
	const guard = new Promise((resolve, reject) => {
		setTimeout(() => {
			if (settled) return;
			if (controller) controller.abort();
			reject(new Error('timeout'));
		}, FETCH_TIMEOUT_MS);
	});

	return Promise.race([fetch(STATE_URL, init), guard])
		.then((res) => {
			settled = true;
			if (!res.ok) throw new Error('HTTP ' + res.status);
			return res.json();
		})
		.catch((error) => {
			settled = true;
			throw error;
		});
}

/** 1 → 2 → 4 → 8 → 15秒（上限15秒）＋ジッター。 */
function backoffMs() {
	const step = Math.pow(2, Math.max(0, attempts - 1));
	return Math.min(POLL_MS / 2 * step, MAX_BACKOFF_MS) * (1 + Math.random() * 0.2);
}

function requestRefresh() {
	const now = Date.now();
	if (now - forcedRefreshAt < 1500) return;
	forcedRefreshAt = now;
	clearTimeout(pollTimer);
	pollTimer = setTimeout(poll, 0);
}

let pollTimer = null;
let polling = false;
let recoverHits = 0; // 通信断から戻るときの連続受信回数

function onSnapshot(raw) {
	const wasOffline = offline;
	lastAt = Date.now();
	if (raw && num(raw.serverTime) !== null) offset = raw.serverTime - Date.now();

	// build が変わったら自動リロード（§7）。リロードは灰の画面を見せてから。
	const build = raw && typeof raw.build === 'string' ? raw.build : '';
	if (build && lastBuild && build !== lastBuild) {
		offline = true;
		attempts = 0;
		renderOffline();
		location.reload();
		return;
	}
	if (build) lastBuild = build;

	// 復帰は受信が3回続いてから。1回で戻すと、落ちかけのホストで
	// 灰→色→灰 とちらつく（§11-2）。
	if (wasOffline) {
		recoverHits += 1;
		if (recoverHits < RECOVER_HITS) {
			if (raw) {
				const next0 = normalize(raw);
				if (next0) model = next0;
			}
			renderOffline();
			return;
		}
		recoverHits = 0;
		offline = false;
		attempts = 0;
	} else {
		attempts = 0;
	}

	// seq は2秒ごとに +1。飛んだ／戻ったら全体を取り直す。
	const seq = raw ? num(raw.seq) : null;
	if (seq !== null && lastSeq !== null && seq !== lastSeq + 1) requestRefresh();
	if (seq !== null) lastSeq = seq;

	const next = normalize(raw);
	if (!next) return;
	model = next;
	tickers = [];
	// 復帰後も差分は使わない。全体スナップショットを1枚受けてから描く。
	render();
	syncAlertSound();
}

function poll() {
	if (polling) return;
	polling = true;
	fetchState()
		.then((raw) => {
			polling = false;
			onSnapshot(raw);
			clearTimeout(pollTimer);
			pollTimer = setTimeout(poll, POLL_MS);
		})
		.catch((error) => {
			polling = false;
			attempts += 1;
			// 通信断は「最後に受信してから6秒」で決める（1回の失敗では切らない）。
			renderOffline();
			clearTimeout(pollTimer);
			pollTimer = setTimeout(poll, backoffMs());
			void error;
		});
}

/** 通信断の判定。6秒受信が無ければ灰の全画面へ。 */
function watchOffline() {
	if (offline) {
		renderOffline();
		return;
	}
	const age = receivedAge();
	if (age !== null && age > OFFLINE_MS) {
		offline = true;
		renderOffline();
	}
}

/* ── 常時表示のための小物（§8）─────────────────────────────────────────── */

/** 3秒操作が無ければカーソルを消す。 */
let cursorTimer = null;
function showCursor() {
	document.body.classList.remove('cursor-hidden');
	clearTimeout(cursorTimer);
	cursorTimer = setTimeout(() => {
		document.body.classList.add('cursor-hidden');
	}, 3000);
}

/** Wake Lock。無い環境では何もしない。 */
let wakeLock = null;
function requestWakeLock() {
	if (!navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') return;
	if (document.visibilityState !== 'visible') return;
	navigator.wakeLock
		.request('screen')
		.then((sentinel) => {
			wakeLock = sentinel;
			sentinel.addEventListener('release', () => {
				wakeLock = null;
			});
		})
		.catch(() => {});
}

/** 焼き付き対策。10分ごとに固定要素を数pxずらす。 */
const SHIFTS = [
	[0, 0],
	[3, 2],
	[6, 0],
	[3, -2],
	[0, -3],
	[-3, -2],
	[-6, 0],
	[-3, 2],
];
let shiftIndex = 0;
function shiftBoard() {
	shiftIndex = (shiftIndex + 1) % SHIFTS.length;
	refs.app.style.setProperty('--sx', SHIFTS[shiftIndex][0] + 'px');
	refs.app.style.setProperty('--sy', SHIFTS[shiftIndex][1] + 'px');
}

/* ── 起動 ───────────────────────────────────────────────────────────────── */

readQuery();
refs.sound.addEventListener('click', onSoundButton);
document.addEventListener('keydown', (event) => {
	if (event.metaKey || event.ctrlKey || event.altKey) return;
	if (event.target instanceof HTMLInputElement) return;
	const key = event.key;
	if (key === ' ' || key === 'Spacebar' || key === 'Enter') {
		if (offline || !model) return;
		if (model.overall !== 'needs-you' && model.overall !== 'alarm') return;
		event.preventDefault();
		ack();
		return;
	}
	if (key === 'd' || key === 'D') {
		if (offline) return;
		detailOpen = !detailOpen;
		tickers = [];
		render();
		return;
	}
	if (key === 'r' || key === 'R') {
		poll();
	}
});

document.addEventListener('click', (event) => {
	const target = event.target;
	if (target && target.closest && target.closest('button')) return;
	if (offline) return;
	detailOpen = !detailOpen;
	tickers = [];
	render();
	showCursor();
});

document.addEventListener('mousemove', showCursor);
document.addEventListener('mousedown', showCursor);
showCursor();

document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'visible') {
		requestWakeLock();
		poll();
	}
});

window.addEventListener('resize', () => {
	if (model && !offline) render();
});

requestWakeLock();
setInterval(shiftBoard, 600000);
setInterval(() => {
	if (offline) {
		watchOffline();
		return;
	}
	paintClock();
	paintTickers();
	// 夜間の切り替わりも毎分見る。
	refs.app.dataset.night = isNight() ? '1' : '0';
	syncSound();
	syncAlertSound();
}, TICK_MS);
setInterval(watchOffline, OFFLINE_TICK_MS);

renderOffline();
poll();
