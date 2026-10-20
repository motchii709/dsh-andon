#!/usr/bin/env node
/**
 * Headless-Edge screenshots of both boards, for the visual review loop.
 *
 *   node tools/preview.mjs --port 4173      # in another shell; must be running
 *   node tools/shots.mjs [--port 4173] [--out shots] [--edge <path>]
 *
 * Two things this script exists to stop getting wrong by hand:
 *
 * `--force-device-scale-factor=1` is not optional. Without it Edge applies the
 * OS DPI scale and the CSS viewport ends up roughly half the requested window
 * size, so every clamp() lands at its lower bound and the screenshot shows a
 * layout that nobody will ever see. Debugging that once was enough.
 *
 * `?scenario=` must be explicit on every URL. The preview server keeps the
 * scenario as module-level state, and only a page load that names one resets
 * it; a shot taken without the parameter inherits whatever the previous page
 * used. That silently made the kanban board render empty.
 */
import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

const flag = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const PORT = Number(flag('port', '4173'));
const OUT = resolve(flag('out', join(HERE, '..', 'shots')));
const BUDGET = Number(flag('budget', '3000'));

const EDGE_CANDIDATES = [
	flag('edge', ''),
	'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
	'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
	'/usr/bin/microsoft-edge',
	'/usr/bin/google-chrome',
].filter(Boolean);

const EDGE = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!EDGE) {
	console.error('Edge not found. Pass --edge <path to msedge.exe>.');
	process.exit(1);
}

/** Board, scenario, and the two viewports worth checking. */
const BOARDS = ['andon', 'kanban'];
const SCENARIOS = ['alarm', 'busy', 'quiet', 'empty'];
const VIEWPORTS = [
	{ tag: 'desk', width: 1920, height: 1080 },
	{ tag: 'tablet', width: 1024, height: 768 },
	// Phone is the one that breaks silently, so it is not optional.
	//
	// `scale: 2` is a workaround, not a preference. Headless Edge clamps the
	// real window to a ~500px minimum, so asking for a 390px window lays the
	// page out at 500 and then crops the screenshot to 390 — which reads as
	// "the board overflows the phone" even when the CSS is correct. Asking for
	// a 780px window at device-scale-factor 2 gives a 390 CSS px viewport, and
	// the capture comes back at 2x for easier inspection.
	{ tag: 'phone', width: 390, height: 844, scale: 2 },
];

async function shoot({ board, scenario, tag, width, height, scale = 1 }) {
	const file = join(OUT, `${board}-${scenario}-${tag}.png`);
	const url = `http://127.0.0.1:${PORT}/${board}/?scenario=${scenario}`;
	const profile = join(tmpdir(), `dsh-andon-shot-${process.pid}-${board}-${scenario}-${tag}`);
	try {
		await run(EDGE, [
			'--headless=new',
			'--disable-gpu',
			'--hide-scrollbars',
			'--no-first-run',
			'--force-device-scale-factor=' + scale,
			'--window-size=' + width * scale + ',' + height * scale,
			'--virtual-time-budget=' + BUDGET,
			'--user-data-dir=' + profile,
			'--screenshot=' + file,
			url,
		], { timeout: 60000, windowsHide: true });
		return file;
	} finally {
		await rm(profile, { recursive: true, force: true }).catch(() => {});
	}
}

await mkdir(OUT, { recursive: true });

let failures = 0;
for (const board of BOARDS) {
	for (const scenario of SCENARIOS) {
		for (const viewport of VIEWPORTS) {
			const label = `${board}/${scenario}/${viewport.tag} ${viewport.width}x${viewport.height}`;
			try {
				const file = await shoot({ board, scenario, ...viewport });
				console.log(`ok   ${label} -> ${file}`);
			} catch (error) {
				failures += 1;
				console.error(`fail ${label}: ${String(error?.message ?? error).split('\n')[0]}`);
			}
		}
	}
}

console.log(`\n${(BOARDS.length * SCENARIOS.length * VIEWPORTS.length) - failures} shots in ${OUT}`);
process.exit(failures === 0 ? 0 : 1);
