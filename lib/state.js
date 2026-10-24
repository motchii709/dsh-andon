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

/** Session event types that mean "the session produced something".
 *
 *  Used only for `lastOutputAt` (CONTRACT-v2 §2): the "running but silent for
 *  five minutes" watch line needs the last time work visibly moved. The list is
 *  the output half of `KNOWN_SESSION_EVENT_TYPES` (dsh-session
 *  known-event-types): agent turns, tool traffic, workspace writes, compaction.
 *  Deliberately NOT here:
 *    - `user/message`   the human spoke; that is input, not the session working
 *    - `session/title`  a side-channel write
 *    - `approval/*`     a request for permission says nothing about progress
 *  An unlisted type is simply not output; nothing is inferred in its place. */
const OUTPUT_EVENT_TYPES = new Set([
	'assistant/attempt',
	'assistant/message',
	'turn/start',
	'turn/end',
	'step/start',
	'step/end',
	'tool/call',
	'tool/result',
	'tool/ptc-dispatch',
	'tool/ptc-dispatch-start',
	'tool-workflow/agent-start',
	'tool-workflow/agent-end',
	'tool-workflow/run-start',
	'tool-workflow/run-end',
	'workspace/changes',
	'todo/write',
	'command/done',
	'deliverables/presented',
	'compaction/start',
	'compaction/summary',
	'compaction/end',
]);

/** Upper bound on remembered per-session output times. Live harnesses churn
 *  sessions all day; this map is bookkeeping, not an archive. */
const MAX_OUTPUT_SESSIONS = 256;

/* ── v2: the four states (CONTRACT-v2 §1) ─────────────────────────────────────
 *
 *  `offline` is deliberately absent: only the client can see a dead link, so
 *  only the client owns that state (CONTRACT-v2 §1, 仕様書 §7).
 *
 *  The rank is the whole priority rule (“worst wins”). Every comparison in this
 *  file — per session, and across sessions for `overall` — goes through it, so
 *  there is exactly one place where “worse” is defined. */
const STATE_RANK = { normal: 0, watch: 1, 'needs-you': 2, alarm: 3 };

/** The judge's defaults. CONTRACT-v2 §1 gives these numbers; config overrides. */
const RULE_DEFAULTS = {
	/** running, but nothing has come out of the session for this long */
	noOutputMs: 300_000,
	/** context use that earns 注意 */
	contextWarnPct: 80,
	/** context use that earns 異常 */
	contextAlarmPct: 90,
	/** a human-blocking wait that has been sitting this long is 異常, not 要対応 */
	needsYouStaleMs: 300_000,
	/** how long a ws gap the *client* calls offline (sent back so the two sides
	 *  cannot drift; this server never uses it) */
	offlineMs: 6_000,
	/** snapshot cadence on the ws stream */
	heartbeatMs: 2_000,
};

/** Human wording for the log (CONTRACT-v2 §2 `log[].text`, §4 “内部イベント名
 *  のログ” を消す).
 *
 *  Keyed by the `kind` tag each activity line carries, NOT by the visible
 *  activity text: the activity ring is a legacy surface with its own wording
 *  (`入力`, `実行開始`) pinned by older callers, while the log is the sentence a
 *  person reads on a wall. Most activity lines are already human (`承認待ち:
 *  bash`, `変更 3ファイル`, `pnpm install 完了`) and are passed through
 *  untouched — only the ones that name an internal event, or that are too terse
 *  to read, appear here. One table, so the whole vocabulary is reviewable in
 *  one screen. */
const LOG_TEXT = {
	'user-message': '指示を受信',
	'agent-run': 'タスク開始',
	'agent-idle': '待機に入った',
	'problem': '問題が発生',
};

/** Anything shaped like a session event type (`llm/retry`) is an internal name
 *  and must never reach the wall. Used as the last line of defence in
 *  `logTextOf` for a line whose text was not written for humans. */
const INTERNAL_NAME = /[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*/iu;

/** Log lines are cut at 40 characters (CONTRACT-v2 §4.5). */
const LOG_TEXT_MAX = 40;
/** The contract ceiling for `log[]` (CONTRACT-v2 §2「最大40行」). */
const MAX_LOG = 40;
/** How many of those lines actually go on the wire.
 *
 *  The board draws 10 lines, so 12 leaves two lines of headroom for the instant
 *  between a repaint and the next frame. This is where most of the transfer cost
 *  sat: 13 lines of Japanese text were 1,747 B of a 15,200 B payload, and the
 *  bytes past the tenth line were drawn by nobody.
 *
 *  Dropping the *oldest* lines is allowed (they are off-screen anyway); dropping
 *  the newest is not, so the slice always keeps the head of the newest-first
 *  ring — see `buildLog`. */
const LOG_WIRE_LINES = 12;

/* ── the 24h band (`history[]`) ──────────────────────────────────────────────
 *
 *  One minute per code, 24 hours of them (仕様書 §7). Sent run-length encoded
 *  by `historyWire` so a full band costs a bounded number of bytes instead of a
 *  row object per minute. */
const HISTORY_STEP_MS = 60_000;
const HISTORY_MINUTES = 1440;
/** Hard ceiling for the encoded band, in characters. A 24h band of solid state
 *  is a handful of characters; only a board that changes every minute gets near
 *  this, and then the old end is dropped. */
const HISTORY_MAX_CHARS = 1400;
/** Wire codes. One character per state, no words: the band is a colour strip,
 *  and the client owns the mapping back to colours. */
const HISTORY_CODE = { normal: 'n', watch: 'w', 'needs-you': 'y', alarm: 'a' };
/** "nothing was reported in this minute" — deliberately not `n`. A gap and a
 *  normal minute are different claims (§0). */
const HISTORY_GAP = '-';

/** Keys a tool call's JSON arguments are read for, most telling first. The point
 *  is a one-glance summary (`bash: node test/state.test.mjs`), not a faithful
 *  reproduction of the call. */
const TOOL_ARG_KEYS = [
	'command',
	'path',
	'file_path',
	'filePath',
	'pattern',
	'query',
	'url',
	'description',
	'prompt',
	'label',
	'cwd',
];

/** The text of a model message (`content` is a string or a block array). */
function messageText(content) {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	const parts = [];
	for (const block of content) {
		if (block && typeof block.text === 'string' && block.text) parts.push(block.text);
	}
	return parts.join(' ');
}

/** A short hint from a tool call's `arguments` (JSON string, usually). */
/** Shorten path-like fragments for a wall board.
 *
 *  `C:\Users\<name>\Documents\DSH\playgrounds\dsh-andon\README.md` is 60
 *  characters of home directory that nobody reads from 3m away, and it puts the
 *  account name on a shared screen. Keep the last two segments: still says which
 *  file, stops saying who and where.
 *
 *  Two shapes arrive: a bare path (`edit: <path>`) and a path inside a longer
 *  string (`pwsh: cd "C:\Users\...\dsh-andon"`). The second one is why a plain
 *  "is this whole value a path" test was not enough — the live board still showed
 *  the home directory after the first version of this function. */
function shortenHint(value) {
	const text = String(value);
	if (!/[\\/]/u.test(text)) return text;

	// A value that *is* a path: keep only its tail.
	if (!/\s/u.test(text)) {
		const parts = text.split(/[\\/]+/u).filter(Boolean);
		return parts.length > 2 ? parts.slice(-2).join('\\') : text;
	}

	// A longer string: rewrite every absolute path inside it, leave the rest.
	// Only the last segment here — the hint is capped at 24 characters, and
	// `cd "playgrounds\dsh-andon"` truncated to `cd "playgrounds\dsh-and…`
	// keeps the useless half and drops the name.
	return text.replace(/[A-Za-z]:[\\/][^\s"'`]+/gu, (match) => {
		const parts = match.split(/[\\/]+/u).filter(Boolean);
		return parts.length > 1 ? parts[parts.length - 1] : match;
	});
}

function toolArgHint(raw) {
	if (typeof raw !== 'string' || raw === '') return '';
	let parsed = null;
	try {
		parsed = JSON.parse(raw);
	} catch {
		parsed = null;
	}
	if (!parsed || typeof parsed !== 'object') return clampText(shortenHint(raw), 24);
	for (const key of TOOL_ARG_KEYS) {
		const value = parsed[key];
		if (typeof value === 'string' && value.trim()) return clampText(shortenHint(value), 24);
	}
	for (const value of Object.values(parsed)) {
		if (typeof value === 'string' && value.trim()) return clampText(shortenHint(value), 24);
	}
	return '';
}

/** One human line describing what a session just produced (CONTRACT-v2 §2
 *  `lastOutput`), or '' when the event carries nothing worth showing.
 *
 *  Same rules as the log: no internal event name ever reaches the string, and 40
 *  characters at most. Structural events (`turn/start`, `step/end`) deliberately
 *  produce nothing — "a step ended" is not something a person can act on, and
 *  letting them answer would push the last real sentence off the card. */
function describeOutput(type, data) {
	const body = data ?? {};
	switch (type) {
		case 'assistant/message':
			return clampText(messageText(body.message?.content), LOG_TEXT_MAX);
		case 'user/message': {
			// `content` for the real UserMessage; `text` for the simplified shape
			// some fixtures and older logs carry.
			const text = clampText(messageText(body.content ?? body.text), LOG_TEXT_MAX - 4);
			// Prefixed so a card never shows the human's words as if the agent had
			// said them. This is the fallback line for a session that has been
			// instructed but has not produced anything of its own yet.
			return text ? `指示: ${text}` : '';
		}
		case 'tool/call': {
			const name = clampText(body.name ?? body.toolName ?? '', 16);
			const hint = toolArgHint(body.arguments);
			if (!name) return hint;
			return hint ? clampText(`${name}: ${hint}`, LOG_TEXT_MAX) : name;
		}
		case 'tool/result': {
			const reason = body.error?.name ?? body.error?.code ?? '';
			return reason ? clampText(`${clampText(reason, 20)} で失敗`, LOG_TEXT_MAX) : '';
		}
		case 'workspace/changes': {
			const total = count(body.total);
			return total > 0 ? `${total}ファイルを変更` : '';
		}
		case 'todo/write':
			return '手順を更新';
		case 'command/done':
			return 'コマンド完了';
		case 'deliverables/presented':
			return '成果物を提示';
		case 'compaction/start':
		case 'compaction/summary':
		case 'compaction/end':
			return '文脈を圧縮';
		default:
			return '';
	}
}

/** "6分" / "45秒" / "2時間" — the unit a reader uses, not milliseconds. */
function durationJa(ms) {
	if (!Number.isFinite(ms) || ms < 0) return '—';
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}秒`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}分`;
	return `${Math.round(minutes / 60)}時間`;
}

function stateRank(value) {
	return STATE_RANK[value] ?? 0;
}

/** Merge `config.rules` over the documented defaults.
 *
 *  A threshold that is not a finite non-negative number is ignored rather than
 *  accepted as NaN: a NaN threshold silently disables a rule, which on this
 *  board means an alarm that never fires. */
function normalizeRules(input) {
	const source = input && typeof input === 'object' ? input : {};
	const rules = { ...RULE_DEFAULTS };
	for (const key of Object.keys(RULE_DEFAULTS)) {
		const value = Number(source[key]);
		if (Number.isFinite(value) && value >= 0) rules[key] = value;
	}
	return rules;
}

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

/** Payload build tag. Bumping it makes every open board reload itself (§7), so
 *  change it in the same commit as any client-visible shape change. Exported so
 *  the degraded payload in index.js cannot drift from the real one.
 *
 *  v2.1: the wire stopped carrying the v1 keys (`cards` / `alerts` / `activity` /
 *  `vitals` / `host` / `generatedAt` / the v1 counters), `log[]` was cut to 12
 *  lines, and `history[]` became `[fromMs, stepMs, codes]` (see `historyWire`).
 *  All three are client-visible shape changes, hence the bump: a board left open
 *  on the old JavaScript must reload rather than read the new `history`. */
export const BUILD = 'and-on-v2.1';

/* ── collector ───────────────────────────────────────────────────────────── */

/** @param ctx cordis host context.
 *  @param options.rules threshold overrides (see RULE_DEFAULTS /
 *         CONTRACT-v2 §1). Missing or invalid values fall back to the defaults.
 *  @param options.legacyPayload put the v1 keys on the wire too (the transition
 *         switch; `legacyPayload: true` in the plugin config). Off by default:
 *         66% of the payload was data no v2 screen reads. */
export function createCollector(ctx, options = {}) {
	const notes = new Set();
	const rules = normalizeRules(options.rules);
	/** v1 keys on the wire? See `wireOf` / `snapshot`. */
	const legacyPayload = options.legacyPayload === true;

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
		/** sessionId -> epoch ms of the last event that counts as *output*.
		 *
		 *  v2 needs a per-session "when did this session last say anything"
		 *  (CONTRACT-v2 §2 `lastOutputAt`). It is filled only from events this
		 *  collector actually observes: a session whose log was never seen has
		 *  no entry at all, and the payload reports `null` for it. Filling it
		 *  with the session's `createdAt` — or with "now" — would be a guess,
		 *  and CONTRACT-v2 §0 forbids inventing values on a wall board. */
		lastOutputAt: new Map(),
		/** sessionId -> { at, text }: the newest output *that had something to
		 *  say* (CONTRACT-v2 §2 `lastOutput`). Kept apart from `lastOutputAt`
		 *  because the newest event is often a structural one (`step/end`) whose
		 *  line would be empty — the card should still show the last real
		 *  sentence, not 取得不可. */
		lastOutput: new Map(),
		/** sessionId -> epoch ms the agent started running (v2 `runningSince`).
		 *  Only set when `agent/status` actually told us it went running; an
		 *  agent that was already running before the plugin loaded stays
		 *  unknown (`null`) rather than being back-filled with a guess. */
		runningSince: new Map(),
		/** sessionId -> { state, since }: the last verdict this collector
		 *  published, so `since` marks when the state *changed* rather than
		 *  when the snapshot happened to be built. */
		verdicts: new Map(),
		/** sessionId -> epoch ms the inbox was first seen non-empty. The event
		 *  that queued the message is not observable, so the age of an
		 *  input wait is a lower bound — the safe direction for an alarm. */
		inputSince: new Map(),
		/** sessionIds that failed to start an agent (explicit error signal) */
		failedSessions: new Set(),
		/** sessionIds that ended (disposed / stopped) while still listed */
		endedSessions: new Set(),
		/** snapshot counter behind `seq` (CONTRACT-v2 §2) */
		seq: 0,
		/** minuteBucket -> worst state in that minute (24h band, `history[]`) */
		history: new Map(),
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
	 *  identical "応答" rows that told the reader nothing. Repeats of the same
	 *  text inside REPEAT_WINDOW_MS fold into one row with `count`, which the UI
	 *  prints as "応答 ×3". `at` stays at the first occurrence so the timestamp
	 *  marks when the run started, not when it last ticked.
	 *
	 *  Folding is across sessions on purpose: the ticker has one column and no
	 *  room to say which session an event came from, so "応答 ×4" for the whole
	 *  house is the useful reading while four separate "応答" rows are noise.
	 *
	 *  `kind` is a coarse tag ('user-message', 'job', 'approval-asked', …) that
	 *  the v2 `log[]` uses to choose its wording (see LOG_TEXT). The visible
	 *  `text` is left exactly as the legacy boards want it. */
	function pushActivity(text, severity, sessionId, at, kind) {
		const line = clampText(text, 120);
		if (!line) return;
		const when = Number.isFinite(at) ? at : Date.now();
		const sid = sessionId ? String(sessionId) : null;
		const head = state.activity[0];
		if (head && head.text === line && when - head.at <= REPEAT_WINDOW_MS) {
			head.count += 1;
			// A folded run keeps its worst severity.
			if (severity === 'alert' || (severity === 'warn' && head.severity === 'ok')) {
				head.severity = severity;
			}
			return;
		}
		state.activity.unshift({
			at: when,
			severity: severity === 'alert' || severity === 'warn' ? severity : 'ok',
			text: line,
			sessionId: sid,
			count: 1,
			kind: typeof kind === 'string' ? kind : null,
		});
		if (state.activity.length > MAX_ACTIVITY) state.activity.length = MAX_ACTIVITY;
	}

	/* ── per-session output clock ──────────────────────────────────────── */

	/** Remember that `sessionId` produced output at `at`, and — when the event
	 *  carried something a person can read — what it said.
	 *
	 *  Only ever called from an event this collector actually saw (live or in the
	 *  session log). There is no default: a session with no entry is reported as
	 *  `null` and the client prints 取得不可 (CONTRACT-v2 §2).
	 *
	 *  Neither the clock nor the line ever moves backwards. A re-read log can
	 *  hand back an older `time`, and a "last output" that jumps back ten minutes
	 *  would light the 無反応 lamp on a session that just finished a turn.
	 *  Equal timestamps *do* replace the line: the later arrival is the newer
	 *  observation when the clock has only millisecond resolution. */
	function markOutput(sessionId, at, line) {
		if (!sessionId) return;
		const id = String(sessionId);
		const when = Number.isFinite(at) ? at : Date.now();
		const previous = state.lastOutputAt.get(id);

		if (previous === undefined || when > previous) {
			// `Map` keeps insertion order, so the first key is the stalest one.
			if (previous === undefined && state.lastOutputAt.size >= MAX_OUTPUT_SESSIONS) {
				const oldest = state.lastOutputAt.keys().next();
				if (!oldest.done) state.lastOutputAt.delete(oldest.value);
			}
			state.lastOutputAt.set(id, when);
		}

		if (!line || !line.text) return;
		rememberLine(id, line);
	}

	/** Keep the newest line a session produced, independently of the clock.
	 *
	 *  Split out because two kinds of event feed it: output (with the clock) and
	 *  a human instruction (the line only — the human speaking is not the session
	 *  outputting). Newest wins; on an exact tie the later arrival wins, since
	 *  the clock only has millisecond resolution. */
	function rememberLine(id, line) {
		if (!line || !line.text) return;
		const at = Number.isFinite(line.at) ? line.at : Date.now();
		const previous = state.lastOutput.get(id);
		if (previous && at < previous.at) return;
		if (previous === undefined && state.lastOutput.size >= MAX_OUTPUT_SESSIONS) {
			const oldest = state.lastOutput.keys().next();
			if (!oldest.done) state.lastOutput.delete(oldest.value);
		}
		state.lastOutput.set(id, { at, text: clampText(line.text, LOG_TEXT_MAX) });
	}

	/** Note that a run seems to have started at `at` (CONTRACT-v2 §2
	 *  `runningSince`). Source priority, strongest first:
	 *
	 *    1. an `agent/status → running` transition this collector saw
	 *    2. the newest `turn/start` in the log
	 *    3. the newest `step/start`
	 *    4. the newest `user/message` — the moment work was handed over, i.e. a
	 *       lower bound on when the current run began
	 *
	 *  All four are observations. Nothing is derived from `createdAt` or from
	 *  "now", so a session with no such event still reports `null` and the client
	 *  prints 取得不可. Later sources may only move the value forward: the newest
	 *  observation is the current run. */
	function markRunStart(sessionId, at) {
		if (!sessionId || !Number.isFinite(at)) return;
		const id = String(sessionId);
		const known = state.runningSince.get(id);
		if (known === undefined || at > known) state.runningSince.set(id, at);
	}

	/* ── session events: approvals + activity ──────────────────────────── */

	function onSessionEvent(session, event) {
		if (!event || typeof event !== 'object') return;
		const type = typeof event.type === 'string' ? event.type : event.kind;
		if (!type) return;
		const data = event.data ?? event.payload ?? {};
		const sessionId = session?.header?.id ?? session?.id ?? null;
		const at = Number.isFinite(event.time) ? event.time : Date.now();

		// Before the switch: several types return early below, and output is
		// output whether or not the event also earned a ticker line.
		if (OUTPUT_EVENT_TYPES.has(type)) {
			markOutput(sessionId, at, { at, text: describeOutput(type, data) });
			// The start of a run, from whichever event can prove one happened.
			if (type === 'turn/start' || type === 'step/start') markRunStart(sessionId, at);
		} else if (type === 'user/message' && sessionId) {
			// A human instruction is not the session's output, so it never moves
			// the clock — but it is (a) the line a card falls back to while the
			// agent has said nothing yet and (b) the moment work was handed over.
			rememberLine(String(sessionId), { at, text: describeOutput('user/message', data) });
			markRunStart(sessionId, at);
		}

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
				pushActivity(`承認待ち: ${clampText(data.toolName ?? '不明', 40)}`, 'alert', sessionId, at, 'approval-asked');
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
					'approval-decided',
				);
				return;
			}
			case 'user/message':
				pushActivity('入力', 'ok', sessionId, at, 'user-message');
				return;
			case 'assistant/message':
				// Deliberately NOT recorded. It is the most frequent event in the
				// system and the least informative ("a turn finished"), so on a
				// busy harness it occupied every ticker row with the same word and
				// hid the events that actually say something happened. The board
				// still reflects the turn through the session and agent counts.
				// It is still *output* for `lastOutputAt` — see the markOutput call
				// above the switch, which runs before this early return.
				return;
			case 'workspace/changes': {
				const total = count(data.total);
				if (total > 0) pushActivity(`変更 ${total}ファイル`, 'ok', sessionId, at, 'workspace-changes');
				return;
			}
			default:
				// Anything that names a failure is worth a line; everything else
				// (tool results, deltas) would drown the board.
				// `type` is an internal event name (`llm/retry`). It stays in the
				// legacy activity ring, but the v2 log carries the 'problem' tag
				// and prints 問題が発生 instead (see LOG_TEXT / logTextOf).
				if (/error|failed|abort/i.test(type)) {
					pushActivity(`${type}`, 'alert', sessionId, at, 'problem');
				}
		}
	}

	/* ── per-session output seeding ────────────────────────────────────── */

	/** Prime `lastOutputAt` from the logs that already exist.
	 *
	 *  Subscribing only ever sees events from *now on*, so on a harness that has
	 *  been running for hours every session comes up with `lastOutputAt: null`.
	 *  That is not just a missing column: the `watch` rule — running but silent
	 *  for `noOutputMs` — reads `lastOutputAt`, so without this it can never
	 *  fire and a hung session never leaves 正常. It is the one alarm this board
	 *  exists for (仕様書 §2), so it cannot depend on the plugin happening to be
	 *  loaded before the session started.
	 *
	 *  Reading the session log is *observation*, not inference: the timestamp
	 *  comes from an event that is actually in the log. A session whose log has
	 *  no output event stays `null`.
	 *
	 *  The whole (bounded) slice is scanned for the newest match rather than
	 *  stopping at the first one from the tail: log order is not a promise we
	 *  own, and a single out-of-order row would otherwise date the session by
	 *  its second-most-recent output.
	 *
	 *  The same pass backfills the two fields the board draws next to it:
	 *  `lastOutput` (the newest event that had something to say) and
	 *  `runningSince` (the newest `turn/start`, which is what "実行が始まった
	 *  時刻" means). Both stay `null` when the log does not carry them. */
	function seedOutput() {
		const sessions = safe(() => svc.sessions?.list() ?? []);
		if (!sessions) return;
		for (const session of sessions) {
			const id = sessionIdOf(session);
			if (!id) continue;
			const events = safe(() => session?.snapshotEvents?.() ?? []);
			if (!events?.length) continue;
			const slice = events.length > SEED_EVENT_LIMIT ? events.slice(-SEED_EVENT_LIMIT) : events;
			let newest = null;
			let outputLine = null;
			let instructionLine = null;
			let runStart = null;
			for (let i = slice.length - 1; i >= 0; i -= 1) {
				const event = slice[i];
				const type = event?.type;
				if (!Number.isFinite(event?.time)) continue;
				const at = event.time;

				if (!OUTPUT_EVENT_TYPES.has(type)) {
					if (type === 'user/message') {
						const text = describeOutput('user/message', event.data ?? {});
						if (text && (instructionLine === null || at > instructionLine.at)) {
							instructionLine = { at, text };
						}
						if (runStart === null || at > runStart) runStart = at;
					}
					continue;
				}

				if (newest === null || at > newest) newest = at;
				const text = describeOutput(type, event.data ?? {});
				if (text && (outputLine === null || at > outputLine.at)) outputLine = { at, text };
				if (type === 'turn/start' || type === 'step/start') {
					if (runStart === null || at > runStart) runStart = at;
				}
			}
			if (newest !== null) {
				// The agent's own words win; a human instruction is only the
				// fallback for a session that has not said anything itself.
				markOutput(id, newest, outputLine ?? instructionLine);
			} else if (instructionLine !== null) {
				rememberLine(id, instructionLine);
			}
			if (runStart !== null) markRunStart(id, runStart);
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
				if (!known?.has(id)) pushActivity(`承認待ち: ${toolName}`, 'alert', sessionId, at, 'approval-asked');
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
					'job',
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
				undefined,
				'session-start',
			);
		});
		on('session/disposed', (session) => {
			const id = session?.header?.id;
			for (const [approvalId, entry] of state.pending) {
				if (entry.sessionId === id) state.pending.delete(approvalId);
			}
			if (id) {
				state.endedSessions.add(String(id));
				state.runningSince.delete(String(id));
			}
			pushActivity('セッション終了', 'ok', id ?? null, undefined, 'session-end');
		});
		on('agent/status', ({ agent, status }) => {
			if (!agent) return;
			const sessionId = agentSessionIdOf(agent);
			// `runningSince` (CONTRACT-v2 §2): the moment this collector saw the
			// agent go running. An agent already running at plugin load has no
			// entry and reports null.
			if (sessionId) {
				const id = String(sessionId);
				if (status === 'running') {
					if (!state.runningSince.has(id)) state.runningSince.set(id, Date.now());
					state.endedSessions.delete(id);
					// A successful start clears an earlier failure: otherwise one
					// bad start would keep the session at `error` (and the board at
					// 異常) for the rest of the process's life.
					state.failedSessions.delete(id);
				} else {
					state.runningSince.delete(id);
				}
			}
			pushActivity(
				status === 'running' ? '実行開始' : '待機',
				'ok',
				sessionId,
				undefined,
				status === 'running' ? 'agent-run' : 'agent-idle',
			);
		});
		on('subagent/start', (info) => {
			pushActivity('サブエージェント開始', 'ok', info?.id ?? null, undefined, 'subagent-start');
		});
		on('subagent/end', (info) => {
			const failed = /error|fail|abort/i.test(String(info?.stopReason ?? ''));
			pushActivity(
				`サブエージェント終了${failed ? ` (${clampText(info?.stopReason, 30)})` : ''}`,
				failed ? 'warn' : 'ok',
				info?.id ?? null,
				undefined,
				'subagent-end',
			);
		});
		on('agent-loop/config-start-failed', (payload) => {
			state.startupFailures += 1;
			if (payload?.sessionId) state.failedSessions.add(String(payload.sessionId));
			pushActivity(
				`エージェント起動失敗 (${clampText(payload?.sessionId, 20)})`,
				'alert',
				payload?.sessionId ?? null,
				undefined,
				'agent-start-failed',
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
				for (const task of view?.tasks ?? []) tasks.push({ ...task, ownerSession: agentSessionIdOf(agent) });
			} catch {
				try {
					const list = await svc.agentTeams.listTasks(agent);
					ok = true;
					for (const task of list ?? []) tasks.push({ ...task, ownerSession: agentSessionIdOf(agent) });
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
	seedOutput();
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
		// Same re-read for the output clock: `markOutput` never moves backwards,
		// so a second pass can only fill in what a missed event left blank — in
		// particular sessions that appeared without a `session/created` we saw.
		seedOutput();
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

	/** The session id, from whichever field this DSH version puts it in.
	 *
	 *  The plugin originally read only `session.header.id`. On a live harness
	 *  that produced an empty id map — so the kanban rendered zero cards while
	 *  the andon reported eight live sessions, and pending approvals were
	 *  filtered away entirely (the board could never light 要対応). The shape of
	 *  a session object is not part of any contract we can rely on, so try the
	 *  candidates in order instead of trusting one. */
	function sessionIdOf(session) {
		const id =
			session?.header?.id ??
			session?.identity?.sessionId ??
			session?.identity?.id ??
			session?.id ??
			'';
		return typeof id === 'string' && id ? id : '';
	}

	/** The session id an agent drives.
	 *
	 *  The `Agent` type exposes it as `agent.session` (a whole Session), NOT as
	 *  `agent.sessionId`. Reading `sessionId` returned undefined for every live
	 *  agent, so the kanban built zero cards while the andon reported four
	 *  running agents, and every goal/team lookup was keyed on undefined. Keep
	 *  accepting the flat field for older shapes and for callers that pass a
	 *  plain id. */
	function agentSessionIdOf(agent) {
		const id =
			agent?.session?.header?.id ??
			agent?.sessionId ??
			(agent?.session ? sessionIdOf(agent.session) : '') ??
			'';
		return typeof id === 'string' && id ? id : '';
	}

	function sessionLabel(session) {
		const header = session?.header ?? {};
		const title = projection(session, 'title');
		if (typeof title === 'string' && title.trim()) return clampText(title, 90);
		const cwd = baseName(header.cwd ?? session?.identity?.cwd);
		const id = sessionIdOf(session);
		if (cwd) return `${cwd} · ${shortId(id)}`;
		return shortId(id);
	}

	/** The session's current goal, from whichever source has it.
	 *
	 *  `ctx.goals.get(agent)` yields the plain Goal (with `phase`, `objective`,
	 *  `activation`). The `goal` projection yields a wrapper and has to be
	 *  unwrapped through `.current`. Both are live paths, and a card and the
	 *  counter that disagree about how many goals exist make the whole board
	 *  read as broken, so every caller goes through here. */
	function goalOf(agent, session) {
		return safe(() => svc.goals?.get(agent)) ?? projection(session, 'goal')?.current ?? null;
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

	/** Context use as a whole percent, or `null` when the projection cannot say.
	 *
	 *  `null` (not 0) is the contract's answer for "unknown" (CONTRACT-v2 §2:
	 *  「不明なら null」). A missing projection must never read as 0% used,
	 *  because 0% is a *healthy* claim and this board is not allowed to make
	 *  claims it cannot support. */
	function contextOf(session) {
		const pressure = projection(session, 'contextPressure');
		if (!pressure || !Number.isFinite(pressure.contextWindow) || pressure.contextWindow <= 0) {
			return null;
		}
		const used = count(pressure.projectedTokens) || count(pressure.pressureTokens);
		return {
			pct: Math.round((used / pressure.contextWindow) * 100),
			used,
			window: pressure.contextWindow,
		};
	}

	/* ── the judgement (CONTRACT-v2 §1) ────────────────────────────────────
	 *
	 *  This is the ONLY place a state is decided. The client renders what it is
	 *  told and never re-derives it (仕様書 §7: 状態の判定ロジックはサーバ側に1つ
	 *  だけ). The single exception in the whole system is `offline`, which only
	 *  the client can see; the server never returns it.
	 *
	 *  Precedence, worst wins, checked top to bottom:
	 *    alarm     stale human wait / context ≥ contextAlarmPct / ended badly
	 *    needs-you a human is being waited on
	 *    watch     running but silent ≥ noOutputMs / context ≥ contextWarnPct
	 *    normal    none of the above
	 */

	/** Status of one session, normalised to the four words the contract uses.
	 *
	 *  `error` and `stopped` are only ever reported from an explicit signal this
	 *  collector observed (a failed agent start, a disposal) — never inferred
	 *  from silence, which is `idle`. */
	function sessionStatusOf(id, agent) {
		if (state.failedSessions.has(id)) return 'error';
		if (agent && agent.status === 'running') return 'running';
		if (state.endedSessions.has(id)) return 'stopped';
		return 'idle';
	}

	/** Decide one session. Pure: every input is passed in, nothing is read from
	 *  the clock behind the caller's back, so the rule can be reasoned about in
	 *  one screen. `since` is filled with the moment the *condition* started
	 *  when that is knowable, and left null otherwise (the caller falls back to
	 *  "when we first published this state", which is an honest estimate). */
	function judgeOne(now, facts) {
		const { status, contextPct, lastOutputAt, approvalSince, inputSince } = facts;
		const waitSince = approvalSince ?? inputSince ?? null;

		// ── 1. alarm
		if (waitSince !== null && now - waitSince >= rules.needsYouStaleMs) {
			const waited = durationJa(now - waitSince);
			return {
				state: 'alarm',
				reason: `${approvalSince !== null ? '承認待ち' : '入力待ち'} ${waited}放置`,
				since: waitSince + rules.needsYouStaleMs,
			};
		}
		if (contextPct !== null && contextPct >= rules.contextAlarmPct) {
			return { state: 'alarm', reason: `コンテキスト ${contextPct}%`, since: null };
		}
		if (status === 'error' || status === 'stopped') {
			return {
				state: 'alarm',
				reason: status === 'error' ? 'エラーで停止' : '停止したまま',
				since: null,
			};
		}

		// ── 2. needs-you
		if (approvalSince !== null) return { state: 'needs-you', reason: '承認待ち', since: approvalSince };
		if (inputSince !== null) return { state: 'needs-you', reason: '入力待ち', since: inputSince };

		// ── 3. watch
		if (status === 'running' && lastOutputAt !== null && now - lastOutputAt >= rules.noOutputMs) {
			return {
				state: 'watch',
				reason: `無反応 ${durationJa(now - lastOutputAt)}`,
				since: lastOutputAt + rules.noOutputMs,
			};
		}
		if (contextPct !== null && contextPct >= rules.contextWarnPct) {
			return { state: 'watch', reason: `コンテキスト ${contextPct}%`, since: null };
		}

		// ── 4. normal
		return { state: 'normal', reason: '', since: null };
	}

	/** Judge every live session and combine them (CONTRACT-v2 §1, §2).
	 *
	 *  Returns the `sessions[]` rows plus `overall`, its one-line `reason`, and
	 *  the two counts the header needs. `overall` is the worst row; zero
	 *  sessions is `normal` (an empty harness is not a failure). */
	function judgeSessions(now, input) {
		const rows = [];
		let overall = 'normal';
		let blocked = 0;
		const seen = new Set();

		for (const session of input.sessions) {
			const id = sessionIdOf(session);
			if (!id) continue;
			seen.add(id);

			const status = sessionStatusOf(id, input.agentBySession.get(id) ?? null);
			const contextPct = input.contextPctById.get(id) ?? null;
			const lastOutputAt = state.lastOutputAt.get(id) ?? null;

			// A human-blocking wait: an untouched approval, or queued input.
			let approvalSince = null;
			for (const entry of input.pendingApprovals) {
				if (String(entry.sessionId ?? '') !== id) continue;
				if (approvalSince === null || entry.since < approvalSince) approvalSince = entry.since;
			}
			const inputWaiting = inboxDepth(session) > 0;
			// The queue event itself is unobservable, so the age of an input wait
			// can only be measured from when this collector first saw it: a lower
			// bound, which is the safe direction for an alarm.
			if (inputWaiting) {
				if (!state.inputSince.has(id)) state.inputSince.set(id, now);
			} else {
				state.inputSince.delete(id);
			}
			const inputSince = inputWaiting ? (state.inputSince.get(id) ?? now) : null;
			if (approvalSince !== null || inputSince !== null) blocked += 1;

			const verdict = judgeOne(now, { status, contextPct, lastOutputAt, approvalSince, inputSince });

			// `since` = when this state started. A state that survived from the
			// previous snapshot keeps its original timestamp, so the client's
			// elapsed counter counts a stay, not a refresh.
			const previous = state.verdicts.get(id);
			let since;
			if (previous && previous.state === verdict.state) {
				since =
					verdict.since !== null && verdict.since < previous.since ? verdict.since : previous.since;
			} else {
				since = verdict.since !== null ? verdict.since : now;
			}
			state.verdicts.set(id, { state: verdict.state, since });

			const outputLine = state.lastOutput.get(id);
			rows.push({
				id,
				name: sessionLabel(session),
				status,
				state: verdict.state,
				reason: clampText(verdict.reason, 40),
				since,
				// `since` is the age of the *state*; `runningSince` is the age of
				// the *run*. Only a session that is running right now can claim a
				// run start — an idle session holding yesterday's turn timestamp
				// would read as "実行経過 18時間" (CONTRACT-v2 §2 取り違え注意).
				runningSince: status === 'running' ? (state.runningSince.get(id) ?? null) : null,
				lastOutputAt,
				lastOutput: outputLine ? clampText(outputLine.text, LOG_TEXT_MAX) : null,
				contextPct,
			});

			if (stateRank(verdict.state) > stateRank(overall)) overall = verdict.state;
		}

		// Forget sessions that are gone, or the maps become a leak that only
		// shows up after a week of uptime.
		for (const id of state.verdicts.keys()) if (!seen.has(id)) state.verdicts.delete(id);
		for (const id of state.inputSince.keys()) if (!seen.has(id)) state.inputSince.delete(id);
		for (const id of state.runningSince.keys()) if (!seen.has(id)) state.runningSince.delete(id);

		const worst = rows.filter((row) => row.state === overall && row.reason);
		const reason =
			overall === 'normal' || rows.length === 0
				? ''
				: clampText(`${worst[0]?.reason ?? overall} ${worst.length}件`, 40);

		recordHistory(now, overall);

		return { sessions: rows, overall, reason, needsYou: blocked };
	}

	/** The 24h band (CONTRACT-v2 §2 `history[]`, 仕様書 §7).
	 *
	 *  One minute grain holding the worst state seen in that minute. Kept even
	 *  though the client may still ignore it: a band that starts filling the day
	 *  it is needed cannot be back-filled.
	 */
	function recordHistory(now, overall) {
		const bucket = Math.floor(now / 60_000) * 60_000;
		const current = state.history.get(bucket);
		if (current === undefined || stateRank(overall) > stateRank(current)) {
			state.history.set(bucket, overall);
		}
		const cutoff = bucket - 24 * 60 * 60_000;
		// Copied before deleting: `Map` iteration order is insertion order, which
		// is only *usually* ascending in time. A clock step backwards must not
		// stop the sweep early and leave a day of rows behind.
		for (const at of [...state.history.keys()]) {
			if (at < cutoff) state.history.delete(at);
		}
	}

	/** `history[]` as one compressed run, oldest first (CONTRACT-v2 §2).
	 *
	 *  `[fromMs, stepMs, codes]`:
	 *    - `codes` is a run-length string, `<状態コード><分>`: `"n720a3"` is
	 *      twelve hours of 正常 followed by three minutes of 異常. A bare code
	 *      means one minute.
	 *    - codes: `n` normal / `w` watch / `y` needs-you / `a` alarm / `-` = 記録なし
	 *    - minute `i` covers `[fromMs + i*stepMs, fromMs + (i+1)*stepMs)`
	 *
	 *  Why not one `{at, state}` row per minute: a full band is 1440 rows, and at
	 *  ~28 B each that is 40 KB on every frame — twice the payload budget for a
	 *  4 px strip. Run-length keeps a quiet day under 100 B and a pathological one
	 *  under `HISTORY_MAX_CHARS`.
	 *
	 *  Two properties are deliberate:
	 *    - a gap is `-`, never `n`. "This minute was not reported" and "this
	 *      minute was normal" are different claims, and §0 forbids the second
	 *      when only the first is known.
	 *    - when the encoding would exceed its budget, the OLD end is dropped, the
	 *      same direction as `log[]`: old evidence may be discarded, the recent
	 *      band may not.
	 */
	function historyWire(now) {
		const step = HISTORY_STEP_MS;
		const currentBucket = Math.floor(now / step) * step;
		const keys = [...state.history.keys()].sort((a, b) => a - b);
		if (keys.length === 0) return [currentBucket, step, ''];

		// Never older than the 24h window, even if a clock step left a stray row.
		const from = Math.max(keys[0], currentBucket - HISTORY_MINUTES * step);
		const last = Math.max(keys[keys.length - 1], currentBucket);
		const count = Math.min(Math.floor((last - from) / step) + 1, HISTORY_MINUTES + 1);
		const codes = new Array(count).fill(HISTORY_GAP);
		for (const at of keys) {
			const index = Math.round((at - from) / step);
			if (index >= 0 && index < count) codes[index] = HISTORY_CODE[state.history.get(at)] ?? HISTORY_GAP;
		}

		// Fold equal neighbours into runs.
		const runs = [];
		for (const code of codes) {
			const tail = runs[runs.length - 1];
			if (tail && tail.code === code) tail.minutes += 1;
			else runs.push({ code, minutes: 1 });
		}

		// Budget: drop whole runs off the old end until the string fits. The size
		// of a token is measured on the token itself (`a` is 1 char, `a90` is 3),
		// not on a guess, or the drop loop throws away minutes it did not need to.
		const tokenOf = (run) => (run.minutes === 1 ? run.code : `${run.code}${run.minutes}`);
		let chars = 0;
		for (const run of runs) chars += tokenOf(run).length;
		let first = 0;
		while (chars > HISTORY_MAX_CHARS && first < runs.length - 1) {
			chars -= tokenOf(runs[first]).length;
			first += 1;
		}
		const kept = runs.slice(first);
		let keptMinutes = 0;
		let encoded = '';
		for (const run of kept) {
			keptMinutes += run.minutes;
			encoded += tokenOf(run);
		}
		return [currentBucket - (keptMinutes - 1) * step, step, encoded];
	}

	/* ── the human log (CONTRACT-v2 §2 `log[]`, §4) ──────────────────────── */

	/** Turn one activity line into a sentence for a person (§4: 内部イベント名の
	 *  ログを消す / 40文字).
	 *
	 *  Most activity lines are already written for humans (`承認待ち: bash`,
	 *  `変更 3ファイル`, `pnpm install 完了`) and pass straight through. The ones
	 *  that need help are the terse ring words (`入力`, `実行開始`, `待機`) and
	 *  anything that still looks like an event type — those go through LOG_TEXT,
	 *  or are replaced wholesale rather than printed raw.
	 *
	 *  A folded run keeps its count: `指示を受信 ×5` says more than one line and
	 *  keeps the ring's bound honest. */
	function logTextOf(line) {
		let text = line?.text ?? '';
		const mapped = LOG_TEXT[line?.kind];
		if (typeof mapped === 'string') text = mapped;
		else if (INTERNAL_NAME.test(text)) text = LOG_TEXT.problem;

		if (Number(line?.count) > 1) {
			const suffix = ` ×${count(line.count)}`;
			text = `${clampText(text, LOG_TEXT_MAX - suffix.length)}${suffix}`;
		}
		return clampText(text, LOG_TEXT_MAX);
	}

	function buildLog(sessionsById) {
		// Newest first, and only the head of the ring: the screen draws 10 lines,
		// so the call is capped at LOG_WIRE_LINES and the oldest rows are the
		// ones that fall off. Never the other way round — a log whose newest
		// lines are missing is worse than no log at all.
		const lines = Math.min(LOG_WIRE_LINES, MAX_LOG);
		return state.activity.slice(0, lines).map((line) => {
			const session = line.sessionId ? sessionsById.get(String(line.sessionId)) : null;
			return {
				at: line.at,
				session: session ? clampText(sessionLabel(session), LOG_TEXT_MAX) : '',
				severity: line.severity,
				text: logTextOf(line),
			};
		});
	}

	/* ── snapshot ──────────────────────────────────────────────────────── */

	function buildCards(now, agents, sessionsById, alertsBySession) {
		const cards = [];
		const seen = new Set();

		for (const agent of agents) {
			const id = agentSessionIdOf(agent);
			if (!id || seen.has(id)) continue;
			seen.add(id);
			const session = sessionsById.get(id);
			if (!session) continue;

			const header = session.header ?? {};
			const goal = goalOf(agent, session);
			const stats = projection(session, 'sessionStats') ?? {};
			const pressure = projection(session, 'contextPressure') ?? {};
			const tokens = tokenTotalsOf(projection(session, 'tokenUsage')) ?? {};
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

	/** Unwrap a token-usage projection into the four buckets.
	 *
	 *  The rule that keeps biting: `stateOf` returns the projection *state*, and
	 *  the obvious flat shape is what `wire.view()` publishes. For `tokenUsage`
	 *  the state is `{ totals, last }`, so reading `outputTokens` straight off it
	 *  yields zeros — the header cheerfully reported トークン 0 while the harness
	 *  was burning millions. Accept both shapes. */
	function tokenTotalsOf(state) {
		const source = state?.totals ?? state;
		if (!source || typeof source !== 'object') return null;
		return {
			uncachedInputTokens: count(source.uncachedInputTokens),
			outputTokens: count(source.outputTokens),
			cacheReadTokens: count(source.cacheReadTokens),
			cacheWriteTokens: count(source.cacheWriteTokens),
		};
	}

	/** Unwrap a model-selection projection into the selection actually in use.
	 *
	 *  `stateOf(session, 'modelSelection')` returns `{ lastUsed, pending }`, so
	 *  the selection is one level down. A caller that passes the wrapper
	 *  straight to `modelLine` gets an empty string and the board quietly drops
	 *  its model line, which is the same shape of failure as the goal wrapper. */
	function selectionOf(value) {
		if (!value || typeof value !== 'object') return null;
		if (value.lastUsed || value.pending) return value.lastUsed ?? value.pending ?? null;
		return value;
	}

	function modelLine(selection) {
		selection = selectionOf(selection);
		if (!selection || typeof selection !== 'object') return '';
		const provider = selection.provider ?? selection.providerId;
		const model = selection.model ?? selection.modelId;
		if (provider && model) return `${provider} ${model}`;
		if (model) return String(model);
		return '';
	}

	/** Build the document.
	 *
	 *  `snapshot()` hands back the **whole** transitional document: the v2 keys
	 *  the boards read *and* the v1 keys (`cards`, `alerts`, `activity`,
	 *  `vitals`, …) that the old page and `tools/shots.mjs` still understand.
	 *  What goes *on the wire* is decided by `toJSON`, which is lean by default —
	 *  see `wireOf`. The two shapes are kept apart on purpose:
	 *
	 *    - the v1 keys cost 66% of the payload and no v2 screen reads them, so
	 *      they must not be transferred by default;
	 *    - `?compat=1` and `legacyPayload: true` still get them, because the
	 *      migration is not finished and a missing key is indistinguishable from
	 *      a bug when you are comparing an old board against a new server.
	 *
	 *  `snapshot({ compat: true })` returns a plain (untagged) object, which is
	 *  what the route layer serializes for `?compat=1`. */
	function snapshot(callOptions = {}) {
		const compat = legacyPayload || callOptions?.compat === true;
		const now = Date.now();

		// A failure of *these* two is not a missing column: without the session
		// list the board cannot see anything at all, so a calm green wall would be
		// a claim it has no evidence for (仕様書 §1「嘘の正常を出さない」). Detected
		// before the `?? []` below hides it, and turned into `overall: alarm` with
		// the reason spelled out.
		const sessionList = safe(() => svc.sessions?.list() ?? [], 'セッション一覧を取得できません');
		const agentList = safe(() => svc.agents?.list() ?? [], 'エージェント一覧を取得できません');
		const blind = sessionList === undefined || agentList === undefined;
		const sessions = sessionList ?? [];
		const agents = agentList ?? [];
		const sessionsById = new Map();
		for (const session of sessions) {
			const id = sessionIdOf(session);
			if (id) sessionsById.set(id, session);
		}
		// The join from agent -> session decides whether the kanban has cards at
		// all, and whether a pending approval survives. It silently produced ZERO
		// cards and ZERO approvals on a live harness with 8 sessions, because the
		// only key it trusted was session.header.id. Never again silent: if the
		// join cannot be made, the board says so in notes.
		if (sessions.length > 0 && sessionsById.size === 0) {
			note('セッションの識別子を解決できません（kanban のカードと承認待ちが欠けます）');
		}
		const agentBySession = new Map();
		for (const agent of agents) {
			const sid = agentSessionIdOf(agent);
			if (sid) agentBySession.set(sid, agent);
		}
		// Second failure mode, distinct from the one above: ids resolve, but no
		// agent points at any of them. Then the kanban has no cards even though
		// the andon reports running agents, which is exactly the mismatch a
		// reader would notice first.
		if (agentBySession.size > 0 && sessionsById.size > 0) {
			let joined = 0;
			for (const id of agentBySession.keys()) if (sessionsById.has(id)) joined += 1;
			if (joined === 0) {
				note('エージェントとセッションの対応が取れません（kanban のカードが空になります）');
			}
		}

		// ── goals
		let goalsActive = 0;
		let goalsBlocked = 0;
		let goalsPaused = 0;
		for (const agent of agents) {
			const goal = goalOf(agent, sessionsById.get(agentSessionIdOf(agent)));
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
		/** sessionId -> context % (absent when the projection cannot say) */
		const contextPctById = new Map();
		for (const session of sessions) {
			const context = contextOf(session);
			if (context) {
				const id = sessionIdOf(session);
				if (id) contextPctById.set(id, context.pct);
				if (context.pct > contextPct) {
					contextPct = context.pct;
					contextWindow = context.window;
					contextTokens = context.used;
				}
			}
			const usage = tokenTotalsOf(projection(session, 'tokenUsage'));
			if (usage) {
				tokens.input += usage.uncachedInputTokens;
				tokens.output += usage.outputTokens;
				tokens.cacheRead += usage.cacheReadTokens;
				tokens.cacheWrite += usage.cacheWriteTokens;
			}
		}

		// ── v2 verdict: one judgement for the whole board (CONTRACT-v2 §1)
		const judged = judgeSessions(now, {
			sessions,
			agentBySession,
			pendingApprovals,
			contextPctById,
		});
		const sessionsRunning = judged.sessions.filter((row) => row.status === 'running').length;

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
			const goal = goalOf(agent, sessionsById.get(agentSessionIdOf(agent)));
			if (!goal) continue;
			if (goal.phase === 'blocked') {
				addAlert({
					id: `goal-blocked:${goal.id ?? agentSessionIdOf(agent)}`,
					kind: 'goal',
					severity: 'alert',
					title: `目標が遮断: ${clampText(goal.objective, 70)}`,
					detail: goal.blockedReason?.message ?? goal.blockedReason?.code ?? '',
					sessionId: agentSessionIdOf(agent),
					sessionTitle: '',
					since: Number.isFinite(goal.updatedAt) ? goal.updatedAt : now,
				});
			} else if (goal.phase === 'paused') {
				addAlert({
					id: `goal-paused:${goal.id ?? agentSessionIdOf(agent)}`,
					kind: 'goal',
					severity: 'warn',
					title: `目標が休止: ${clampText(goal.objective, 70)}`,
					detail: '',
					sessionId: agentSessionIdOf(agent),
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
		if (cards.length === 0 && agents.length > 0) {
			// Shape report, printed only when agents exist but not one card could
			// be built — i.e. the agent -> session join failed. A board that cannot
			// build a card otherwise just looks quiet, and finding out why means
			// guessing from outside the host, which is exactly what went wrong
			// here. Keys and types only: no ids, no titles, nothing session-
			// specific ends up on a wall.
			const keys = (value, limit = 8) =>
				value && typeof value === 'object' ? Object.keys(value).slice(0, limit).join('/') : 'none';
			note(
				clampText(
					`カードを作れません: agent[${keys(agents[0])}] session[${keys(sessions[0])}] ` +
						`header[${keys(sessions[0]?.header)}] agentSessionId=${typeof agents[0]?.sessionId} ` +
						`sessionsById=${sessionsById.size}`,
					200,
				),
			);
		}

		// ── vitals
		const workspaces = safe(() => svc.workspaceRegistry?.list() ?? []) ?? [];
		const primaryWorkspace = workspaces.find((w) => w?.active) ?? workspaces[0];
		let modelSelection = null;
		for (const session of sessions) {
			// Same wrapper trap as `goal`: the projection hands back
			// `{ lastUsed, pending }`, so reading `.provider` off it yields
			// nothing and the header silently loses its model line.
			modelSelection = selectionOf(projection(session, 'modelSelection'));
			if (modelSelection) break;
		}

		// ── v2 envelope (CONTRACT-v2 §2)
		// `seq` counts snapshots, so a client that sees it jump or repeat knows a
		// frame was lost and re-reads. `build` is the auto-reload trigger (§7) and
		// must change whenever the client-facing shape does.
		state.seq += 1;

		// A board that cannot see must not read as healthy. `offline` belongs to
		// the client (it is the only one that can see a dead link), so the server's
		// strongest honest word is `alarm` — with the reason saying why, rather
		// than blaming a session that has done nothing wrong.
		const overall = blind ? 'alarm' : judged.overall;
		const overallReason = blind ? '状態を収集できません' : judged.reason;
		// The band records it too: a 24h strip that stayed green through a blind
		// hour is the same lie, one screen further away.
		if (blind) recordHistory(now, 'alarm');

		return finalize(
			{
				// ── v2 keys (new; the boards read these)
				v: 2,
				serverTime: now,
				seq: state.seq,
				build: BUILD,
				overall,
				reason: overallReason,
			sessions: judged.sessions,
			log: buildLog(sessionsById),
			history: historyWire(now),
			// ── v1 keys (kept while the boards are replaced; see CONTRACT-v2 §2
			// 「既存キーは残す」). `status` is the legacy ok/warn/alert gauge built
			// from the eight stations — a *different* rule set from `overall`, which
			// is the v2 verdict. Both are reported until the old boards are gone.
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
				// v2 header (CONTRACT-v2 §2 counts). `needsYou` counts sessions with
				// a human-blocking wait — approvals *and* queued input, including the
				// ones already escalated to alarm, so the big number never reads 0
				// while a card on the same screen is shouting.
				needsYou: judged.needsYou,
				running: sessionsRunning,
				contextMax: contextPct,
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
			},
			compat,
		);
	}

	/** Decide the wire shape of one document (`snapshot`).
	 *
	 *  `wireOf` is the lean default: exactly the keys CONTRACT-v2 §2 documents,
	 *  and nothing else. Every v1 key stays behind `?compat=1` /
	 *  `legacyPayload: true`:
	 *
	 *    schema / stations / cards / alerts / activity / vitals / host /
	 *    generatedAt / status / counts(旧)
	 *
	 *  Measured on the reference host: those were 10,012 B of a 15,200 B payload
	 *  (66%), drawn by no v2 screen.
	 *
	 *  `notes` *is* on the wire, v1 key or not: without it a client cannot tell a
	 *  quiet harness from a blind one and would paint a healthy green wall over a
	 *  collector that can see nothing (仕様書 §1). Usually `[]` — 12 B. */
	function wireOf(full) {
		return {
			v: full.v,
			serverTime: full.serverTime,
			seq: full.seq,
			build: full.build,
			overall: full.overall,
			reason: full.reason,
			// CONTRACT-v2 §2 の3つだけ。v1 の内訳（liveSessions / agentsRunning / …）
			// は v2 画面が読まない。
			counts: {
				needsYou: full.counts.needsYou,
				running: full.counts.running,
				contextMax: full.counts.contextMax,
			},
			sessions: full.sessions,
			log: full.log,
			history: full.history,
			notes: full.notes,
		};
	}

	/** Attach the wire shape, or hand back the plain document for `compat`.
	 *
	 *  `toJSON` (not a copy) is what makes `JSON.stringify(snapshot())` lean
	 *  everywhere at once: the HTTP route, the ws frames, and `tools/preview.mjs`
	 *  all serialize the same object, so none of them can drift back to the heavy
	 *  shape by accident. */
	function finalize(full, compat) {
		if (compat) return full;
		Object.defineProperty(full, 'toJSON', {
			value: () => wireOf(full),
			enumerable: false,
			configurable: true,
		});
		return full;
	}

	function dispose() {
		for (const disposer of disposers) safe(() => disposer());
		disposers.length = 0;
		for (const id of timers) clearInterval(id);
		timers.length = 0;
	}

	// `lastOutputAt` is not part of the HTTP payload on its own — the v2
	// `sessions[]` rows carry it — but it is exposed the same way `pending` is,
	// for the route layer and for anyone debugging a session that will not stop
	// saying 無反応. `rules` is the merged threshold set: the stream needs
	// `heartbeatMs` from here so the two sides cannot disagree about cadence.
	return {
		snapshot,
		dispose,
		/** Append one line to the human log (and so to `log[]`).
		 *
		 *  The ACK route uses this: CONTRACT-v2 §2 says an ACK leaves one line in
		 *  the log and *changes nothing else* — acknowledging stops the client's
		 *  blinking and sound, not the state on the board. */
		pushLog(text, severity, kind) {
			pushActivity(text, severity, null, Date.now(), kind);
		},
		get pending() {
			return state.pending;
		},
		get lastOutputAt() {
			return state.lastOutputAt;
		},
		get lastOutput() {
			return state.lastOutput;
		},
		get rules() {
			return { ...rules };
		},
	};
}
