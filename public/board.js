/* dsh-andon / board.js — shared client runtime for /andon and /kanban.
 *
 * No dependencies. ES module, served straight from /andon/assets/board.js.
 * Contains only things BOTH pages need: DOM building, formatting, the poller,
 * the connection indicator and the keyboard shortcuts. Page-specific rendering
 * lives in andon.js / kanban.js.
 */

/* ── DOM ─────────────────────────────────────────────────────────────────── */

/**
 * Build an element. Attributes are set as properties where they exist on the
 * node (value, textContent, className…) and as attributes otherwise. Children
 * may be nodes, strings or null/undefined (skipped).
 */
export function h(tag, attrs, ...children) {
	const node = document.createElement(tag);
	if (attrs) {
		const keys = Object.keys(attrs);
		for (let i = 0; i < keys.length; i += 1) {
			const key = keys[i];
			const value = attrs[key];
			if (value === null || value === undefined || value === false) continue;
			if (key === 'class') node.className = value;
			else if (key === 'text') node.textContent = value;
			else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
			else if (key === 'dataset' && typeof value === 'object') Object.assign(node.dataset, value);
			else if (key.startsWith('on') && typeof value === 'function') {
				node.addEventListener(key.slice(2).toLowerCase(), value);
			} else if (value === true) node.setAttribute(key, '');
			else node.setAttribute(key, String(value));
		}
	}
	append(node, children);
	return node;
}

export function append(parent, children) {
	for (const child of children) {
		if (child === null || child === undefined || child === false) continue;
		if (Array.isArray(child)) append(parent, child);
		else if (child instanceof Node) parent.appendChild(child);
		else parent.appendChild(document.createTextNode(String(child)));
	}
	return parent;
}

export function clear(node) {
	while (node.firstChild) node.removeChild(node.firstChild);
	return node;
}

export function mount(node, ...children) {
	clear(node);
	append(node, children);
	return node;
}

/* ── formatting ──────────────────────────────────────────────────────────── */

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Compact Japanese duration. `3分` / `2時間` / `4日`. */
/** Zero-padded 2-digit field. padStart is ES2017 (Chrome 57); the Fire tab's Silk is older. */
function pad2(n) {
	return n < 10 ? "0" + n : String(n);
}

export function fmtDur(ms) {
	if (!Number.isFinite(ms) || ms < 0) return '—';
	if (ms < MIN) return 'たった今';
	if (ms < HOUR) return `${Math.floor(ms / MIN)}分`;
	if (ms < DAY) return `${Math.floor(ms / HOUR)}時間`;
	return `${Math.floor(ms / DAY)}日`;
}

/** Longer form used in the detail drawer: `2時間14分`. */
export function fmtDurLong(ms) {
	if (!Number.isFinite(ms) || ms < 0) return '—';
	const d = Math.floor(ms / DAY);
	const hr = Math.floor((ms % DAY) / HOUR);
	const mi = Math.floor((ms % HOUR) / MIN);
	if (d > 0) return `${d}日${hr}時間`;
	if (hr > 0) return `${hr}時間${mi}分`;
	if (mi > 0) return `${mi}分`;
	return `${Math.floor(ms / 1000)}秒`;
}

export function fmtClock(ts) {
	const d = new Date(ts);
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function fmtClockShort(ts) {
	const d = new Date(ts);
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Compact magnitude: 812 / 48.2k / 1.31M. Used for tokens and event counts. */
export function fmtNum(n) {
	if (!Number.isFinite(n)) return '—';
	const abs = Math.abs(n);
	if (abs < 1000) return String(Math.round(n));
	if (abs < 10000) return n.toFixed(abs < 1000 ? 0 : 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	if (abs < 1000000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1000000).toFixed(2)}M`;
}

export function clampText(value, max = 200) {
	if (typeof value !== 'string') return '';
	const flat = value.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Tail of a path, for card subtitles. Handles both separators. */
export function baseName(p) {
	if (typeof p !== 'string' || p === '') return '';
	const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
	return parts[parts.length - 1] || p;
}

export const SEV_RANK = { alert: 0, warn: 1, ok: 2 };

export function worst(a, b) {
	return SEV_RANK[a] <= SEV_RANK[b] ? a : b;
}

/** Overall status for a list of severities. alert > warn > ok. */
export function worstOf(severities) {
	let out = 'ok';
	for (const sev of severities) out = worst(out, sev === 'warn' || sev === 'alert' ? sev : 'ok');
	return out;
}

/* ── poller ──────────────────────────────────────────────────────────────── */

/**
 * Poll a JSON endpoint forever.
 *
 * - pauses while the tab is hidden (an always-on board that is off-screen does
 *   not need to keep the CPU warm), but fires immediately on return
 * - backs off on failure instead of hammering a dead host
 * - never throws: every failure lands in `onError`
 *
 * Returns { stop, refresh, get last }.
 */
export function createPoller({ url, intervalMs = 2000, onData, onError }) {
	let timer = null;
	let controllerTimer = null;
	let stopped = false;
	let failures = 0;
	let inFlight = null;
	let last = null;

	/* One fetch, as a promise chain rather than async/await.
	 *
	 * This file has to parse on the Fire tab's Silk, which is a Chromium from
	 * before async/await (Chrome 55) and before AbortController (Chrome 66).
	 * Optional chaining, `??`, `**`, `Object.entries`, `padStart` and numeric
	 * separators are all out for the same reason: a parse error here means the
	 * board sits on 読み込み中 forever with no clue why. A timeout is still
	 * enforced without AbortController by racing the request against a timer. */
	function tick() {
		if (stopped || inFlight) return Promise.resolve();
		const hasAbort = typeof AbortController === 'function';
		const controller = hasAbort ? new AbortController() : null;
		const init = { cache: 'no-store', headers: { accept: 'application/json' } };
		if (controller) init.signal = controller.signal;
		inFlight = controller || true;

		let settled = false;
		const guard = new Promise((_, reject) => {
			controllerTimer = setTimeout(() => {
				if (settled) return;
				if (controller) controller.abort();
				reject(new Error('timeout'));
			}, 8000);
		});

		return Promise.race([fetch(url, init), guard])
			.then((res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return res.json();
			})
			.then((data) => {
				settled = true;
				failures = 0;
				last = data;
				if (onData) onData(data);
			})
			.catch((error) => {
				settled = true;
				if (stopped) return;
				failures += 1;
				if (onError) onError(error, failures, last);
			})
			.then(() => {
				clearTimeout(controllerTimer);
				inFlight = null;
			});
	}

	function schedule() {
		if (stopped) return;
		if (typeof document !== 'undefined' && document.hidden) {
			timer = setTimeout(schedule, 1000);
			return;
		}
		// 2s nominal, then 2s → 4s → 8s → 15s cap while the host is unreachable.
		const delay = failures === 0 ? intervalMs : Math.min(intervalMs * Math.pow(2, failures), 15000);
		timer = setTimeout(() => {
			tick().then(schedule);
		}, delay);
	}

	document.addEventListener('visibilitychange', () => {
		if (!document.hidden) {
			clearTimeout(timer);
			tick().then(schedule);
		}
	});

	tick().then(schedule);

	return {
		stop() {
			stopped = true;
			clearTimeout(timer);
			if (inFlight) inFlight.abort();
		},
		refresh() {
			clearTimeout(timer);
			tick().then(schedule);
		},
		get last() {
			return last;
		},
	};
}

/* ── connection indicator ────────────────────────────────────────────────── */

/**
 * Drives a `.conn` element: `ok` while data is fresh, `stale` once the data is
 * older than ~3 intervals, `down` after a failure. Returns { update, fail }.
 */
export function createConnection(node, { staleAfterMs = 6000 } = {}) {
	const label = node.querySelector('[data-role="conn-label"]');
	let lastOkAt = Date.now();
	let failed = false;

	function render() {
		const age = Date.now() - lastOkAt;
		let state = 'ok';
		if (failed || age > staleAfterMs * 2) state = 'down';
		else if (age > staleAfterMs) state = 'stale';
		node.dataset.state = state;
		if (label) label.textContent = state === 'ok' ? 'LIVE' : state === 'stale' ? '更新遅延' : '切断中';
	}

	return {
		update() {
			lastOkAt = Date.now();
			failed = false;
			render();
		},
		fail() {
			failed = true;
			render();
		},
		tick: render,
	};
}

/* ── clock ───────────────────────────────────────────────────────────────── */

/** Ticks a clock element every second. Never stops, even while disconnected. */
export function startClock(node) {
	const tick = () => {
		node.textContent = fmtClock(Date.now());
	};
	tick();
	const id = setInterval(tick, 1000);
	return () => clearInterval(id);
}

/* ── browser chrome ──────────────────────────────────────────────────────── */

/**
 * Reflect the board status in the tab title so a background tab still signals.
 * No emoji, no blinking characters — just a bracketed prefix.
 */
export function setTitle(status, base) {
	const prefix = status === 'alert' ? '[要対応] ' : status === 'warn' ? '[注意] ' : '';
	const next = `${prefix}${base}`;
	if (document.title !== next) document.title = next;
}

/** True when this browser can go fullscreen at all. Amazon Silk on Fire OS 5
 *  only implements the webkit-prefixed API, so checking just the standard name
 *  hides the control on exactly the device that needs it. */
export function canFullscreen() {
	const el = document.documentElement;
	return Boolean(el.requestFullscreen || el.webkitRequestFullscreen);
}

export function isFullscreen() {
	return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
}

/** Toggle fullscreen, with the prefixed fallbacks old Silk needs.
 *
 *  On the Fire tab the browser chrome (URL bar, tabs) eats a slab of the screen
 *  and the board is meant to be glanced at from a distance, so this is worth a
 *  tap target. Failures are swallowed: a tap that does nothing is better than an
 *  exception on a wall board. */
export function toggleFullscreen() {
	try {
		if (isFullscreen()) {
			if (document.exitFullscreen) document.exitFullscreen();
			else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
			return;
		}
		const el = document.documentElement;
		if (el.requestFullscreen) el.requestFullscreen();
		else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
	} catch {
		/* a browser that refuses is not an error worth showing */
	}
}

/* ── keyboard ────────────────────────────────────────────────────────────── */

/** Kiosk-friendly keys. `r` refresh, `f` fullscreen, `o` other page, `?` help. */
export function bindKeys({ onRefresh, onOther, onHelp } = {}) {
	document.addEventListener('keydown', (event) => {
		if (event.target instanceof HTMLInputElement) return;
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		switch (event.key) {
			case 'r':
				if (onRefresh) onRefresh();
				break;
			case 'f':
				toggleFullscreen();
				break;
			case 'o':
				if (onOther) onOther();
				break;
			case '?':
				if (onHelp) onHelp();
				break;
			default:
				break;
		}
	});
}

/* ── boot ────────────────────────────────────────────────────────────────── */

/** Removes the `booting` class so CSS can suppress the first paint flash. */
export function boot(root) {
	requestAnimationFrame(() => root.classList.remove('booting'));
}
