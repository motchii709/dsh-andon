/* v2 契約の受け入れテスト（docs/CONTRACT-v2.md）
 *
 * これは `test/state.test.mjs` とは**別に走らせる**。理由: v2 の実装が入る途中で
 * こちらが赤くなっても、実装担当が使う `node test/state.test.mjs` を巻き込まないため。
 *
 *   node test/v2-contract.test.mjs
 *
 * 検査するのは仕様書の受け入れ条件のうち、サーバ側で完結する部分:
 *   §2  5状態モデルと worst-wins（offline はサーバが返さない）
 *   §2  しきい値（contextWarnPct=80 / contextAlarmPct=90）
 *   §3  未知の値は null（推測で埋めない）
 *   §4  log は人間の言葉・40文字で切る・新しい順・最大40行
 * クライアント側（通信断・再接続・時計補正）はここでは扱わない。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCollector } from '../lib/state.js';
import { createMockCtx, settle } from './mock-ctx.mjs';

const STATES = ['normal', 'watch', 'needs-you', 'alarm'];
const STATUSES = ['running', 'idle', 'error', 'stopped'];

async function snapshotWith(overrides) {
	const mock = createMockCtx(overrides);
	const collector = createCollector(mock.ctx, overrides?.collectorOptions);
	await settle(6);
	const snap = collector.snapshot();
	collector.dispose();
	return snap;
}

/** Point every session's context pressure at a fixed percentage. */
function contextAt(percent) {
	const window = 262144;
	return {
		sessionProjections: {
			stateOf: (session, key) =>
				key === 'contextPressure'
					? { projectedTokens: Math.round((window * percent) / 100), contextWindow: window }
					: undefined,
		},
	};
}

test('the snapshot carries the v2 envelope', async () => {
	const snap = await snapshotWith();

	assert.equal(snap.v, 2, 'v2 payloads are versioned');
	assert.ok(Number.isFinite(snap.serverTime), 'serverTime drives every elapsed time on the client');
	assert.ok(Number.isInteger(snap.seq) && snap.seq >= 0, 'seq is what detects a dropped frame');
	assert.ok(STATES.includes(snap.overall), `overall was ${snap.overall}`);
	assert.notEqual(snap.overall, 'offline', 'offline is the client’s call — the server cannot know it');
	assert.equal(typeof snap.reason, 'string');

	for (const key of ['needsYou', 'running', 'contextMax']) {
		assert.ok(Number.isFinite(snap.counts[key]), `counts.${key} is missing`);
	}
	assert.ok(Array.isArray(snap.sessions), 'sessions[] is what the new board is built from');
	assert.ok(Array.isArray(snap.log), 'log[] is the human-readable stream');
	assert.ok(Array.isArray(snap.history), 'history[] is the 24h band');
});

test('every session carries the fields the board draws, and unknown values stay null', async () => {
	const snap = await snapshotWith();
	assert.ok(snap.sessions.length > 0, 'the fixture has live sessions');

	for (const session of snap.sessions) {
		assert.equal(typeof session.id, 'string');
		assert.ok(session.id.length > 0);
		assert.equal(typeof session.name, 'string');
		assert.ok(session.name.length > 0, 'a card with no name is not usable — fall back to the short id');
		assert.ok(STATUSES.includes(session.status), `status was ${session.status}`);
		assert.ok(STATES.includes(session.state), `state was ${session.state}`);
		assert.equal(typeof session.reason, 'string');
		assert.ok(Number.isFinite(session.since), 'since anchors the elapsed counter');

		// §3: 取得できないものは null。0 や現在時刻で埋めたら気づけるようにする。
		assert.ok(
			session.lastOutputAt === null || Number.isFinite(session.lastOutputAt),
			'lastOutputAt must be a time or null, never a placeholder',
		);
		assert.ok(
			session.contextPct === null || (session.contextPct >= 0 && session.contextPct <= 100),
			`contextPct was ${session.contextPct}`,
		);
	}
});

test('worst-wins: one bad session sets the whole board', async () => {
	const snap = async (percent) => snapshotWith(contextAt(percent));

	// 82% is above the 80% warn line and below the 90% alarm line.
	const warn = await snap(82);
	// フィクスチャには承認待ちと失敗ジョブが入っているので overall は alarm になる
	// （それが worst-wins の正しい姿）。ここで見たいのは**しきい値**なので、
	// overall ではなく各セッションの state と counts.contextMax を検査する。
	assert.equal(warn.counts.contextMax, 82, 'counts.contextMax reports the worst session');
	assert.ok(
		warn.sessions.every((s) => s.state !== 'normal'),
		'82% is above the 80% warn line: no session may still read 正常',
	);
	assert.ok(
		warn.sessions.some((s) => s.state === 'watch'),
		'82% alone is 注意 (watch), not 異常',
	);

	// 95% crosses the alarm line: context alone is enough to alarm every session.
	const alarm = await snap(95);
	assert.equal(alarm.counts.contextMax, 95);
	assert.ok(
		alarm.sessions.every((s) => s.state === 'alarm'),
		'95% is above the 90% alarm line: every session must be 異常',
	);
	assert.equal(alarm.overall, 'alarm', 'a board with an alarmed session is alarmed');

	// しきい値の下限側も見る: 79% はまだ 正常（80% を跨いでいない）。
	const below = await snap(79);
	assert.ok(
		below.sessions.some((s) => s.state === 'normal'),
		'79% is below the warn line, so at least one session stays 正常',
	);
});

test('log lines are human words, capped at 40 characters, newest first', async () => {
	const snap = await snapshotWith();
	assert.ok(snap.log.length > 0, 'the fixture produces log lines');
	assert.ok(snap.log.length <= 40, 'at most 40 lines are sent');

	const internal = /\b(user\/message|assistant\/message|tool\/call|tool\/result|workspace\/changes|approval\/asked|approval\/decided|session\/title|turn\/start|turn\/end|step\/start|step\/end)\b/;

	let previous = Infinity;
	for (const line of snap.log) {
		assert.ok(Number.isFinite(line.at), 'each line has a time');
		assert.ok(!internal.test(line.text), `internal event name leaked into the log: ${line.text}`);
		assert.ok(['ok', 'warn', 'alert'].includes(line.severity), `severity was ${line.severity}`);
		assert.ok(line.text.length <= 40, `log line is ${line.text.length} chars, cap is 40: ${line.text}`);
		assert.ok(line.at <= previous, 'lines are newest first');
		previous = line.at;
	}
});

test('no card ever shows the home directory', async () => {
	const snap = await snapshotWith();

	// A tool argument like C:\Users\<name>\Documents\...\README.md is 60
	// characters of home directory. On a shared wall it also names the account.
	// The collector shortens path-like tool hints to their last two segments.
	// The fixture has an `edit` tool call whose argument is an absolute path, so
	// this cannot pass by there being nothing to look at.
	const withPath = snap.sessions.filter((session) => session.lastOutput?.startsWith('edit:'));
	assert.ok(withPath.length > 0, 'the fixture must produce an edit hint for this test to mean anything');

	for (const session of withPath) {
		assert.ok(
			!/[A-Za-z]:[\\/]|Users[\\/]/u.test(session.lastOutput),
			`lastOutput leaks an absolute path: ${session.lastOutput}`,
		);
		assert.match(
			session.lastOutput,
			/README\.md/u,
			'the shortened hint still names the file — dropping the whole value would be worse',
		);
	}
	for (const session of snap.sessions) {
		if (!session.lastOutput) continue;
		assert.ok(
			!/[A-Za-z]:[\\/]|Users[\\/]/u.test(session.lastOutput),
			`lastOutput leaks an absolute path: ${session.lastOutput}`,
		);
	}
	for (const line of snap.log) {
		assert.ok(!/Users[\\/]/u.test(line.text), `log leaks a home path: ${line.text}`);
	}
});
test('a needs-you left alone long enough becomes an alarm (§11-4)', async () => {
	const snap = await snapshotWith();
	const pending = snap.sessions.find((s) => s.reason.includes('放置'));
	assert.ok(pending, 'the fixture has an approval older than the 5 minute line');
	assert.equal(
		pending.state,
		'alarm',
		'a pending approval that nobody answered for 5 minutes is 異常, not 要対応',
	);
});

test('a running session that goes quiet becomes 注意 (§11-5)', async () => {
	// Force one session to look running while its last output is old, and keep
	// context low so the silence rule is the only thing that can fire.
	const mock = createMockCtx({
		sessionProjections: {
			stateOf: () => ({ projectedTokens: 1000, contextWindow: 262144 }),
		},
	});
	const sessions = mock.ctx.sessions.list();
	const target = sessions.find((s) => s.header.id === 'ses_repo000003');
	const ctx = { ...mock.ctx, agents: { list: () => [{ session: target, status: 'running' }], roots: () => [] } };
	const collector = createCollector(ctx);
	await settle(6);
	const snap = collector.snapshot();
	collector.dispose();

	const only = snap.sessions.find((s) => s.id === 'ses_repo000003');
	assert.ok(only, 'the forced session is in the payload');
	assert.equal(only.status, 'running');
	assert.equal(only.state, 'watch', 'running but silent for 5 minutes is 注意');
	assert.match(only.reason, /無反応|出力/u);
});
test('the v1 keys still work while the board is being replaced', async () => {
	const snap = await snapshotWith();

	// The old page and tools/shots.mjs still read these. Dropping them mid-migration
	// would make it impossible to tell a new bug from a missing key.
	for (const key of ['schema', 'generatedAt', 'status', 'host', 'counts', 'stations', 'alerts', 'cards', 'activity', 'vitals', 'notes']) {
		assert.ok(key in snap, `v1 key disappeared: ${key}`);
	}
});
