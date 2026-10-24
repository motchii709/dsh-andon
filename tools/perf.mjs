/* perf.mjs — 軽量化の測定（推測で最適化しないための道具）
 *
 *   node tools/perf.mjs                              # モックで snapshot() を測る
 *   node tools/perf.mjs --url http://127.0.0.1:4240   # 配信中の盤を測る
 *   node tools/perf.mjs --url http://192.168.1.100:3090
 *
 * 出す数値
 *   1) 画面の総重量（HTML + JS + CSS）と gzip 後の推定
 *   2) snapshot() の所要時間（モックを200回）
 *   3) --url を渡したとき: /api/andon/state の実バイト数と内訳
 *
 * 目標は docs/PERF.md。超えたら軽量化の対象。直したら同じコマンドで取り直す。
 */
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

import { createCollector } from '../lib/state.js';
import { createMockCtx, settle } from '../test/mock-ctx.mjs';

const urlArg = process.argv.indexOf('--url');
const base = urlArg >= 0 ? process.argv[urlArg + 1] : null;

const byteSize = (value) => Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');

function breakdown(snap) {
	const v1 = {
		stations: byteSize(snap.stations),
		alerts: byteSize(snap.alerts),
		cards: byteSize(snap.cards),
		activity: byteSize(snap.activity),
		vitals: byteSize(snap.vitals),
	};
	return {
		total: byteSize(snap),
		sessions: byteSize(snap.sessions),
		log: byteSize(snap.log),
		history: byteSize(snap.history),
		v1Total: Object.values(v1).reduce((a, b) => a + b, 0),
		v1,
		counts: {
			sessions: (snap.sessions ?? []).length,
			log: (snap.log ?? []).length,
			history: (snap.history ?? []).length,
		},
	};
}

function assetWeights() {
	const files = [
		['public/andon.html', 'HTML'],
		['public/andon.js', 'JS'],
		['public/board.js', 'JS'],
		['public/tokens.css', 'CSS'],
		['public/md3ex.css', 'CSS'],
	];
	const rows = [];
	let raw = 0;
	let gz = 0;
	for (const [file, kind] of files) {
		const buf = readFileSync(new URL(`../${file}`, import.meta.url));
		const zipped = gzipSync(buf, { level: 6 }).length;
		raw += buf.length;
		gz += zipped;
		rows.push({ file, kind, raw: buf.length, gz: zipped });
	}
	return { rows, raw, gz };
}

async function measureCollector() {
	const mock = createMockCtx();
	const collector = createCollector(mock.ctx);
	await settle(6);
	const snap = collector.snapshot();
	const rounds = 200;
	let bytes = 0;
	const start = process.hrtime.bigint();
	for (let i = 0; i < rounds; i += 1) bytes += JSON.stringify(collector.snapshot()).length;
	const end = process.hrtime.bigint();
	collector.dispose();
	return { ms: Number(end - start) / 1e6 / rounds, bytes: Math.round(bytes / rounds), snap };
}

const assets = assetWeights();
console.log('=== 画面の総重量 ===');
for (const row of assets.rows) {
	console.log(
		`  ${row.file.padEnd(22)} ${String(row.raw).padStart(7)} B   gzip ${String(row.gz).padStart(6)} B  (${row.kind})`,
	);
}
console.log(`  ${'合計'.padEnd(22)} ${String(assets.raw).padStart(7)} B   gzip ${String(assets.gz).padStart(6)} B`);

const local = await measureCollector();
console.log('\n=== snapshot() ===');
console.log(`  ${local.ms.toFixed(3)} ms/回   平均 ${local.bytes} B（モック）`);

if (base) {
	console.log(`\n=== 配信中 ${base} ===`);
	const snap = JSON.parse(await (await fetch(`${base}/api/andon/state`)).text());
	const parts = breakdown(snap);
	console.log(`  payload          ${String(parts.total).padStart(7)} B`);
	console.log(`  sessions[${parts.counts.sessions}]      ${String(parts.sessions).padStart(7)} B`);
	console.log(`  log[${parts.counts.log}]           ${String(parts.log).padStart(7)} B`);
	console.log(`  history[${parts.counts.history}]       ${String(parts.history).padStart(7)} B`);
	console.log(
		`  v1キー（v2画面は未使用） ${String(parts.v1Total).padStart(7)} B  ` +
			Object.entries(parts.v1)
				.map(([k, v]) => `${k}:${v}`)
				.join(' '),
	);
	const perHour = (parts.total / 1024 / 1024) * (3600 / 2); // MB/h（B→MB してから回数）
	console.log(`  2秒ごと1時間     ${perHour.toFixed(1)} MB/h`);
} else {
	const parts = breakdown(local.snap);
	console.log('\n=== モックのペイロード内訳 ===');
	console.log(
		`  payload ${parts.total} B / sessions ${parts.sessions} / log ${parts.log} / history ${parts.history} / v1 ${parts.v1Total}`,
	);
}
