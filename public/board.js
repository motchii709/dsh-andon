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
		for (const [key, value] of Object.entries(attrs)) {
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

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Compact Japanese duration. `3分` / `2時間` / `4日`. */
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
	const p = (n) => String(n).padStart(2, '0');
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtClockShort(ts) {
	const d = new Date(ts);
	const p = (n) => String(n).padStart(2, '0');
	return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Compact magnitude: 812 / 48.2k / 1.31M. Used for tokens and event counts. */
export function fmtNum(n) {
	if (!Number.isFinite(n)) return '—';
	const abs = Math.abs(n);
	if (abs < 1000) return String(Math.round(n));
	if (abs < 10_000) return n.toFixed(abs < 1000 ? 0 : 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	if (abs < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
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
	let stopped = false;
	let failures = 0;
	let inFlight = null;
	let last = null;

	async function tick() {
		if (stopped || inFlight) return;
		const controller = new AbortController();
		const abortTimer = setTimeout(() => controller.abort(), 8000);
		inFlight = controller;
		try {
			const res = await fetch(url, {
				signal: controller.signal,
				cache: 'no-store',
				headers: { accept: 'application/json' },
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			failures = 0;
			last = data;
			onData?.(data);
		} catch (error) {
			if (stopped) return;
			failures += 1;
			onError?.(error, failures, last);
		} finally {
			clearTimeout(abortTimer);
			inFlight = null;
		}
	}

	function schedule() {
		if (stopped) return;
		if (typeof document !== 'undefined' && document.hidden) {
			timer = setTimeout(schedule, 1000);
			return;
		}
		// 2s nominal, then 2s → 4s → 8s → 15s cap while the host is unreachable.
		const delay = failures === 0 ? intervalMs : Math.min(intervalMs * 2 ** failures, 15_000);
		timer = setTimeout(async () => {
			await tick();
			schedule();
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
			inFlight?.abort();
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

export function toggleFullscreen() {
	if (document.fullscreenElement) document.exitFullscreen();
	else document.documentElement.requestFullscreen?.();
}

/* ── keyboard ────────────────────────────────────────────────────────────── */

/** Kiosk-friendly keys. `r` refresh, `f` fullscreen, `o` other page, `?` help. */
export function bindKeys({ onRefresh, onOther, onHelp } = {}) {
	document.addEventListener('keydown', (event) => {
		if (event.target instanceof HTMLInputElement) return;
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		switch (event.key) {
			case 'r':
				onRefresh?.();
				break;
			case 'f':
				toggleFullscreen();
				break;
			case 'o':
				onOther?.();
				break;
			case '?':
				onHelp?.();
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
