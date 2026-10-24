/* dsh-andon — mount two always-on boards onto the harness itself.
 *
 *   GET /andon                     the wall board (status lamps, no interaction)
 *   GET /kanban                    the working board (columns, cards, drawer)
 *   GET /andon/assets/<file>       shared stylesheet + scripts
 *   GET /api/andon/state           the JSON both boards poll
 *   GET /api/andon/health          liveness probe
 *
 * The routes live on `ctx.webServer`, so whatever already reaches the harness
 * (tailnet, tunnel, LAN) reaches the boards. Optionally the same table is also
 * served from a second plain listener on the LAN — see `lan.enabled`.
 *
 * Nothing in the request path is allowed to throw: a broken service costs a
 * `notes[]` entry in the JSON, never a 500 and never a crashed harness.
 */

import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { dirname, join, normalize as normalizePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { createCollector, BUILD } from './state.js';

const name = 'dsh-andon';
const inject = ['webServer'];

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'public');

/** v2 transports (docs/CONTRACT-v2.md §2). */
const STREAM_PATH = '/api/andon/stream';
const ACK_PATH = '/api/andon/ack';

/** RFC 6455 handshake magic. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** A tablet that stops reading must not grow the host's memory: past this much
 *  unsent data the tick is skipped rather than queued. */
const MAX_WS_BACKLOG = 1 << 20;
/** Anything a client sends is tiny (close/ping). Bigger frames are dropped. */
const MAX_WS_INBOUND = 64 << 10;
/** ACK body ceiling. */
const MAX_ACK_BYTES = 4096;

const MIME = {
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
};

const DEFAULTS = {
	/** mount the boards on the harness webserver (the recommended path) */
	exposeOnHarness: true,
	/** where the boards live on the webserver */
	basePath: '/andon',
	/** v2 judgement thresholds (docs/CONTRACT-v2.md §1). Empty = the defaults
	 *  documented there; anything here wins over them. */
	rules: {},
	/** put the v1 keys back on the wire (`cards`, `alerts`, `activity`,
	 *  `vitals`, `stations`, …). Off by default: they were 66% of the payload and
	 *  no v2 screen reads them. `GET /api/andon/state?compat=1` asks for the same
	 *  thing per request. */
	legacyPayload: false,
	/** second, plain listener for tablets that cannot reach the harness */
	lan: {
		enabled: false,
		host: '0.0.0.0',
		port: 3090,
	},
};

function mergeConfig(config) {
	const input = config && typeof config === 'object' ? config : {};
	return {
		...DEFAULTS,
		...input,
		legacyPayload: input.legacyPayload === true,
		rules: { ...DEFAULTS.rules, ...(input.rules && typeof input.rules === 'object' ? input.rules : {}) },
		lan: { ...DEFAULTS.lan, ...(input.lan && typeof input.lan === 'object' ? input.lan : {}) },
	};
}

function send(res, status, contentType, body, extra) {
	res.writeHead(status, {
		'content-type': contentType,
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
		...(extra ?? {}),
	});
	res.end(body);
}

function sendJson(res, status, value) {
	send(res, status, 'application/json; charset=utf-8', `${JSON.stringify(value)}\n`);
}

function redirect(res, location) {
	res.writeHead(302, { location, 'cache-control': 'no-store' });
	res.end();
}

/* ── WebSocket, by hand ──────────────────────────────────────────────────
 *
 * The stream is one-way (server → browser, whole snapshots as JSON text) and has
 * to work in a host that ships no `ws` dependency of its own, so the two pieces
 * of RFC 6455 that matter here are implemented directly on the socket: the
 * handshake accept hash, and writing text frames. No permessage-deflate, no
 * fragmentation of our own frames, no extensions — the client asks for none.
 *
 * The pieces we must still answer correctly are the ones a browser will send:
 * `close` (opcode 0x8) and `ping` (0x9). Ignoring a close leaves a half-open
 * socket whose interval keeps waking up, which is exactly the leak this file
 * refuses to have.
 */

function wsAccept(key) {
	return createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** One unmasked, unfragmented server frame. */
function wsFrame(payload, opcode = 0x1) {
	const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
	const length = body.length;
	let header;
	if (length < 126) {
		header = Buffer.from([0x80 | opcode, length]);
	} else if (length < 0x10000) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	return Buffer.concat([header, body]);
}

function clip(value, max = 40) {
	if (value === null || value === undefined) return '';
	const flat = String(value).replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A degraded-but-valid snapshot. The boards must render *something* even when
 *  the collector itself is broken.
 *
 *  Carries the v2 envelope too: a client that reads only `overall` would
 *  otherwise render a calm grey/normal wall while nothing is being collected at
 *  all. Collection failure is stated as `alarm` with the reason spelled out —
 *  the board is not allowed to look healthy about something it cannot see.
 *
 *  Same lean shape as a healthy frame (`wireOf`), v1 keys and all: the degraded
 *  path is not a reason to put 10 KB of dead keys back on a wall tablet. */
function degradedSnapshot(note, seq) {
	return {
		v: 2,
		serverTime: Date.now(),
		seq,
		build: BUILD,
		overall: 'alarm',
		reason: '状態を収集できません',
		counts: { needsYou: 0, running: 0, contextMax: 0 },
		sessions: [],
		log: [],
		history: [],
		notes: [note],
	};
}

function apply(ctx, config) {
	const options = mergeConfig(config);
	const log = (level, message) => {
		const line = `[dsh-andon] ${message}`;
		try {
			ctx.logger?.[level]?.(line);
		} catch {
			/* logger is a convenience, never a requirement */
		}
	};

	// The judgement thresholds come from plugin config (`rules`, CONTRACT-v2 §1);
	// the collector merges them over the documented defaults. `legacyPayload`
	// decides whether the v1 keys travel on the wire at all.
	const collector = createCollector(ctx, {
		rules: options.rules,
		legacyPayload: options.legacyPayload,
	});
	ctx.effect(() => () => collector.dispose(), 'dsh-andon:collector');

	/* ── handlers ──────────────────────────────────────────────────────── */

	/* ── assets, gzip'd on the way out ─────────────────────────────────────
	 *
	 * The board is 103 KB of HTML/JS/CSS and a wall tablet loads it over Wi-Fi
	 * every time it wakes up. gzip takes that to ~34 KB, and the CPU cost is paid
	 * once per file because the result is cached until the file's mtime changes.
	 *
	 * Only the LAN listener compresses: the harness webserver may own its own
	 * transport (and its own compression), and double-gzipping a response would
	 * break it. `content-length` is the length of the bytes actually sent, and
	 * `vary` names the header the answer depends on.
	 */
	const COMPRESSIBLE = new Set(['.css', '.js', '.html', '.json']);
	const GZIP_MIN_BYTES = 1024;
	const gzipCache = new Map();

	function acceptsGzip(req) {
		const header = req?.headers?.['accept-encoding'];
		return typeof header === 'string' && /\bgzip\b/iu.test(header);
	}

	async function gzipOf(path, raw) {
		let stamp = `len:${raw.length}`;
		try {
			const info = await stat(path);
			stamp = `${info.size}:${Math.round(info.mtimeMs)}`;
		} catch {
			/* keep the length stamp: a wrong cache is worse than a gzip call */
		}
		const hit = gzipCache.get(path);
		if (hit && hit.stamp === stamp) return hit.body;
		const body = gzipSync(raw, { level: 6 });
		gzipCache.set(path, { stamp, body });
		return body;
	}

	/** @param allowGzip true only on the LAN listener. */
	async function serveFile(req, res, file, allowGzip) {
		const path = join(PUBLIC_DIR, normalizePath(file).replace(/^([.]{2}[/\\])+/, ''));
		const raw = await readFile(path);
		const ext = path.slice(path.lastIndexOf('.'));
		const type = MIME[ext] ?? 'application/octet-stream';

		if (allowGzip && COMPRESSIBLE.has(ext) && raw.length >= GZIP_MIN_BYTES) {
			// `vary` goes on both branches: the answer depends on accept-encoding
			// whether or not this particular request asked for gzip.
			if (acceptsGzip(req)) {
				const body = await gzipOf(path, raw);
				send(res, 200, type, body, {
					'content-encoding': 'gzip',
					vary: 'accept-encoding',
					'content-length': String(body.length),
				});
				return;
			}
			send(res, 200, type, raw, { vary: 'accept-encoding', 'content-length': String(raw.length) });
			return;
		}
		send(res, 200, type, raw);
	}

	function page(file) {
		return async (req, res, _url, mode) => {
			try {
				await serveFile(req, res, file, mode?.gzip === true);
			} catch (error) {
				send(res, 500, 'text/plain; charset=utf-8', `dsh-andon: ${file} を読めません\n${String(error?.message ?? error)}\n`);
			}
		};
	}

	function asset(file) {
		return async (req, res, _url, mode) => {
			try {
				await serveFile(req, res, file, mode?.gzip === true);
			} catch {
				send(res, 404, 'text/plain; charset=utf-8', `dsh-andon: ${file} が見つかりません\n`);
			}
		};
	}

	/** Snapshots served while collection is broken. `seq` must keep moving or a
	 *  client would read the repeat as a dropped frame and re-fetch in a loop. */
	let degradedSeq = 0;

	/** `GET /api/andon/state[?compat=1]` (CONTRACT-v2 §2 転送路).
	 *
	 *  Lean by default, whole document on request. `compat=1` and the
	 *  `legacyPayload` config both ask the collector itself for the v1 keys, so
	 *  the compat answer and the default answer can never disagree about the v2
	 *  part — there is one snapshot, serialized two ways. */
	function state(req, res, url) {
		const compat = options.legacyPayload || url?.searchParams?.get('compat') === '1';
		let body;
		try {
			body = collector.snapshot(compat ? { compat: true } : undefined);
		} catch (error) {
			log('error', `snapshot failed: ${String(error?.stack ?? error)}`);
			degradedSeq += 1;
			body = degradedSnapshot('状態の収集に失敗しました', degradedSeq);
		}
		res.writeHead(200, {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			'access-control-allow-origin': '*',
			'x-content-type-options': 'nosniff',
		});
		res.end(`${JSON.stringify(body)}\n`);
	}

	function health(_req, res) {
		const started = Date.now();
		let ok = false;
		try {
			collector.snapshot();
			ok = true;
		} catch {
			ok = false;
		}
		sendJson(res, ok ? 200 : 503, {
			ok,
			schema: 1,
			generatedAt: Date.now(),
			collectMs: Date.now() - started,
			uptimeSec: Math.round(process.uptime()),
			pid: process.pid,
		});
	}

	function notFound(_req, res, url) {
		send(res, 404, 'text/plain; charset=utf-8', `dsh-andon: ${url?.pathname ?? ''} はありません\n`);
	}

	/* ── POST /api/andon/ack (CONTRACT-v2 §2) ──────────────────────────────
	 *
	 * Acknowledging stops the client's blinking and sound. It deliberately
	 * changes no state: the board keeps saying 異常 until the thing that caused
	 * it is gone (§6). All it leaves behind is one line in the log, so the next
	 * person to look at the wall can see that somebody already saw it.
	 *
	 * Every failure path answers with a JSON 4xx; a malformed body from a
	 * half-awake tablet must never take the host down. */

	function ack(req, res) {
		const cors = {
			'access-control-allow-origin': '*',
			'access-control-allow-methods': 'POST, OPTIONS',
			'access-control-allow-headers': 'content-type',
		};

		if (req.method === 'OPTIONS') {
			res.writeHead(204, { ...cors, 'cache-control': 'no-store' });
			res.end();
			return;
		}
		if (req.method !== 'POST') {
			res.writeHead(405, { ...cors, 'content-type': 'application/json; charset=utf-8' });
			res.end(`${JSON.stringify({ ok: false, error: 'POST のみ受け付けます' })}\n`);
			return;
		}

		let settled = false;
		const finish = (status, value) => {
			if (settled) return;
			settled = true;
			res.writeHead(status, { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
			res.end(`${JSON.stringify(value)}\n`);
		};

		const chunks = [];
		let size = 0;
		req.on('data', (chunk) => {
			if (settled) return;
			size += chunk.length;
			if (size > MAX_ACK_BYTES) {
				finish(413, { ok: false, error: '本文が大きすぎます' });
				req.destroy?.();
				return;
			}
			chunks.push(chunk);
		});
		req.on('error', () => finish(400, { ok: false, error: '本文を読めません' }));
		req.on('end', () => {
			if (settled) return;
			let body;
			try {
				body = JSON.parse(chunks.length ? Buffer.concat(chunks).toString('utf8') : '{}');
			} catch {
				finish(400, { ok: false, error: '本文が JSON ではありません' });
				return;
			}
			if (!body || typeof body !== 'object' || Array.isArray(body)) {
				finish(400, { ok: false, error: '本文は JSON オブジェクトである必要があります' });
				return;
			}

			const seq = Number(body.seq);
			const overall = typeof body.overall === 'string' ? clip(body.overall, 20) : '';
			const device = clip(body.device, 40);

			// A confirmation has to say *what* it confirms. `{}` is not an ACK, and
			// answering 200 would hide a client bug behind a success.
			const ACK_STATES = new Set(['normal', 'watch', 'needs-you', 'alarm', 'offline']);
			if (!Number.isFinite(seq) || !ACK_STATES.has(overall)) {
				finish(400, { ok: false, error: 'seq（数値）と overall（状態名）が必要です' });
				return;
			}

			log(
				'info',
				`ACK seq=${Number.isFinite(seq) ? seq : '?'} overall=${overall || '?'} device=${device || '?'}`,
			);
			// One line in the human log, and nothing else.
			try {
				collector.pushLog(
					`確認: ${device || '端末不明'}${overall ? ` (${overall})` : ''}`,
					'ok',
					'ack',
				);
			} catch {
				/* the log is a convenience here, never a requirement */
			}
			finish(200, { ok: true, at: Date.now() });
		});
	}

	/* ── WS /api/andon/stream (CONTRACT-v2 §2) ───────────────────────────── */

	/** Every open socket, so the plugin's teardown can stop all of them. */
	const streams = new Set();

	/** Own one upgraded socket: send the whole snapshot immediately, then on the
	 *  `heartbeatMs` cadence, and stop for good on close/error.
	 *
	 *  The timer is `unref`ed and cleared from `stop()`, which is bound to both
	 *  socket events *and* to the plugin's disposal. A background board must
	 *  never be the reason the host process stays alive, and it must never
	 *  outlive the plugin. */
	function openStream(socket) {
		let timer = null;
		let done = false;

		const stop = () => {
			if (done) return;
			done = true;
			if (timer) clearInterval(timer);
			timer = null;
			streams.delete(stop);
			try {
				socket.destroy();
			} catch {
				/* already gone */
			}
		};

		const send = () => {
			if (done || socket.destroyed || !socket.writable) {
				stop();
				return;
			}
			// A stalled reader costs a skipped frame, not a growing buffer.
			if (socket.writableLength > MAX_WS_BACKLOG) return;
			let body;
			try {
				body = JSON.stringify(collector.snapshot());
			} catch (error) {
				log('error', `stream snapshot failed: ${String(error?.stack ?? error)}`);
				degradedSeq += 1;
				body = JSON.stringify(degradedSnapshot('状態の収集に失敗しました', degradedSeq));
			}
			try {
				socket.write(wsFrame(body));
			} catch {
				stop();
			}
		};

		socket.setNoDelay?.(true);
		socket.on('close', stop);
		socket.on('error', stop);
		socket.on('end', stop);

		// Inbound frames: only close and ping need an answer. Anything else is
		// read past and dropped — this stream carries no client state.
		let inbound = Buffer.alloc(0);
		socket.on('data', (chunk) => {
			if (done) return;
			inbound = inbound.length ? Buffer.concat([inbound, chunk]) : chunk;
			if (inbound.length > MAX_WS_INBOUND) {
				inbound = Buffer.alloc(0);
				return;
			}
			while (inbound.length >= 2) {
				const opcode = inbound[0] & 0x0f;
				const masked = (inbound[1] & 0x80) !== 0;
				let length = inbound[1] & 0x7f;
				let offset = 2;
				if (length === 126) {
					if (inbound.length < 4) return;
					length = inbound.readUInt16BE(2);
					offset = 4;
				} else if (length === 127) {
					if (inbound.length < 10) return;
					length = Number(inbound.readBigUInt64BE(2));
					offset = 10;
				}
				const maskOffset = offset;
				if (masked) offset += 4;
				if (inbound.length < offset + length) return;
				const payload = Buffer.from(inbound.subarray(offset, offset + length));
				if (masked) {
					for (let i = 0; i < payload.length; i += 1) {
						payload[i] ^= inbound[maskOffset + (i % 4)];
					}
				}
				inbound = inbound.subarray(offset + length);
				if (opcode === 0x8) {
					try {
						socket.write(wsFrame(payload.subarray(0, 2), 0x8));
					} catch {
						/* the socket is going away anyway */
					}
					stop();
					return;
				}
				if (opcode === 0x9) {
					try {
						socket.write(wsFrame(payload, 0xa));
					} catch {
						stop();
						return;
					}
				}
			}
		});

		streams.add(stop);
		send();
		timer = setInterval(send, Math.max(250, Number(collector.rules.heartbeatMs) || 2000));
		timer.unref?.();
	}

	/** The upgrade handler shared by the harness webserver and the LAN listener.
	 *
	 *  Doing its own handshake (rather than trusting a transport the host might
	 *  or might not own) keeps the two entry points identical: a tablet on the
	 *  LAN URL gets the same bytes as a browser on the harness. */
	function streamUpgrade(req, socket, _head) {
		const key = req?.headers?.['sec-websocket-key'];
		if (typeof key !== 'string' || key === '') {
			try {
				socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
			} catch {
				/* nothing to say to a dead socket */
			}
			socket.destroy?.();
			return;
		}
		try {
			socket.write(
				'HTTP/1.1 101 Switching Protocols\r\n' +
					'Upgrade: websocket\r\n' +
					'Connection: Upgrade\r\n' +
					`Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
			);
		} catch {
			socket.destroy?.();
			return;
		}
		openStream(socket);
	}

	ctx.effect(
		() => () => {
			for (const stop of [...streams]) stop();
			streams.clear();
		},
		'dsh-andon:streams',
	);

	/** path -> handler. Exact matches only: no prefix rule can accidentally
	 *  shadow a harness route, and a harness route cannot shadow these.
	 *
	 *  Each board is canonical at its trailing-slash URL (`/andon/`) so the
	 *  documents can keep plain relative references (`./assets/tokens.css`) —
	 *  which also means the same files open correctly straight off disk during
	 *  development. The bare path redirects. */
	function buildTable() {
		const base = options.basePath.replace(/\/+$/u, '') || '/andon';
		const boards = [base, '/kanban'];
		const rows = [
			[base, (_req, res) => redirect(res, `${base}/`)],
			[`${base}/`, page('andon.html')],
			['/kanban', (_req, res) => redirect(res, '/kanban/')],
			['/kanban/', page('kanban.html')],
			[`${base}/assets/andon.js`, asset('andon.js')],
			['/kanban/assets/kanban.js', asset('kanban.js')],
			['/api/andon/state', state],
			['/api/andon/health', health],
			[ACK_PATH, ack],
		];
		for (const dir of boards) {
			rows.push([`${dir}/assets/tokens.css`, asset('tokens.css')]);
			rows.push([`${dir}/assets/md3ex.css`, asset('md3ex.css')]);
			rows.push([`${dir}/assets/board.js`, asset('board.js')]);
		}
		return new Map(rows);
	}

	const table = buildTable();
	const homePath = `${options.basePath.replace(/\/+$/u, '') || '/andon'}/`;

	/* ── the same table, reachable without the harness webserver ───────── */

	function lanHandler(req, res) {
		let url;
		try {
			url = new URL(req.url ?? '/', 'http://localhost');
		} catch {
			send(res, 400, 'text/plain; charset=utf-8', 'bad request\n');
			return;
		}
		const handler = table.get(url.pathname) ?? (url.pathname === '/' ? (_req, res) => redirect(res, homePath) : notFound);
		// `{ gzip: true }`: this listener owns its transport, so it may compress.
		// The harness route is handed no mode and stays exactly as it was.
		Promise.resolve()
			.then(() => handler(req, res, url, { gzip: true }))
			.catch((error) => {
				log('error', `lan handler failed for ${url.pathname}: ${String(error?.stack ?? error)}`);
				if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'internal error\n');
			});
	}

	function lanUrls(port) {
		const urls = [`http://127.0.0.1:${port}${homePath}`];
		try {
			for (const [iface, addresses] of Object.entries(networkInterfaces())) {
				for (const address of addresses ?? []) {
					if (address.family !== 'IPv4' || address.internal) continue;
					urls.push(`http://${address.address}:${port}${homePath} (${iface})`);
				}
			}
		} catch {
			/* no interfaces is not a failure */
		}
		return urls;
	}

	let lanServer = null;
	if (options.lan.enabled) {
		lanServer = createServer(lanHandler);
		// The stream lives on the LAN listener too (CONTRACT-v2 §2): the tablet
		// that cannot reach the harness must get the same stream, not a polling
		// fallback. One handler, two entry points.
		lanServer.on('upgrade', (req, socket, head) => {
			let pathname = '';
			try {
				pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
			} catch {
				pathname = '';
			}
			if (pathname !== STREAM_PATH) {
				socket.destroy?.();
				return;
			}
			streamUpgrade(req, socket, head);
		});
		lanServer.on('error', (error) => {
			log('warn', `LAN 待受を開始できません (${options.lan.host}:${options.lan.port}): ${String(error?.message ?? error)}`);
			lanServer = null;
		});
		lanServer.listen(options.lan.port, options.lan.host, () => {
			for (const url of lanUrls(options.lan.port)) log('info', `LAN ボード: ${url}`);
		});
		ctx.effect(
			() => () => {
				lanServer?.close();
				lanServer = null;
			},
			'dsh-andon:lan-listener',
		);
	}

	/* ── mount on the harness webserver ────────────────────────────────── */

	let mounted = 0;
	if (options.exposeOnHarness) {
		for (const [path, handler] of table) {
			try {
				const dispose = ctx.webServer.register({
					kind: 'exact',
					path,
					handler: (req, res) => {
						Promise.resolve()
							.then(() => handler(req, res, new URL(req.url ?? path, 'http://localhost')))
							.catch((error) => {
								log('error', `handler failed for ${path}: ${String(error?.stack ?? error)}`);
								if (!res.headersSent) {
									send(res, 500, 'text/plain; charset=utf-8', 'internal error\n');
								}
							});
					},
				});
				if (typeof dispose === 'function') ctx.effect(() => dispose, `dsh-andon:route:${path}`);
				mounted += 1;
			} catch (error) {
				log('warn', `ルート ${path} を登録できません: ${String(error?.message ?? error)}`);
			}
		}
		try {
			const port = ctx.webServer.port;
			log('info', `ボードを公開しました: http://127.0.0.1:${port}${homePath} (kanban: http://127.0.0.1:${port}/kanban/)`);
		} catch {
			/* port is only used for the log line */
		}
	}

	/* ── the stream, on the harness webserver ──────────────────────────────
	 *
	 * `registerUpgrade` exists on the shipped host webserver but not on every
	 * context this plugin can be mounted on (tests, older hosts), so its absence
	 * is a warning rather than a failure: the boards still work by polling
	 * `GET /api/andon/state`, which is exactly what CONTRACT-v2 §2 requires. */
	if (options.exposeOnHarness) {
		if (typeof ctx.webServer?.registerUpgrade === 'function') {
			try {
				const dispose = ctx.webServer.registerUpgrade({ path: STREAM_PATH, handler: streamUpgrade });
				if (typeof dispose === 'function') ctx.effect(() => dispose, 'dsh-andon:stream');
				log('info', `配信を登録しました: ${STREAM_PATH} (${collector.rules.heartbeatMs}ms 間隔)`);
			} catch (error) {
				log('warn', `配信 ${STREAM_PATH} を登録できません: ${String(error?.message ?? error)}`);
			}
		} else {
			log('warn', `このホストには registerUpgrade がないため配信は無効です（${STREAM_PATH}）`);
		}
	}

	if (!options.exposeOnHarness && !options.lan.enabled) {
		log('warn', 'exposeOnHarness も lan も無効です。ボードはどこからも見えません。');
	}
	log('info', `ルート ${mounted}本を登録しました`);

	/* tear the collector down when the harness goes away */
	ctx.effect(
		() => () => {
			log('info', 'アンドン/カンバンを停止しました');
		},
		'dsh-andon:bye',
	);
}

export { name, inject, apply };
