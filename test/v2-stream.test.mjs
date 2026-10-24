/* WS と ACK の統合テスト（docs/CONTRACT-v2.md §2「転送路」）
 *
 * プレビューサーバ（tools/preview.mjs）はルートを自前で持つので WS を配線していない。
 * そのため本物のプラグインを偽 ctx に載せ、**実 TCP** で
 *   - 101 Switching Protocols と RFC 6455 の accept ハッシュ
 *   - 全スナップショットが seq を進めながら届くこと（差分ではなく全体）
 *   - POST /api/andon/ack が 200 で、ログに1行残り、**状態は消えない**こと
 * を確認する。
 *
 *   node test/v2-stream.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { createHash } from 'node:crypto';

import { apply as applyPlugin } from '../lib/index.js';
import { createMockCtx, settle } from './mock-ctx.mjs';

const WS_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
// RFC 6455 §1.3 の期待値。GUID を打ち間違えたハンドシェイクでも寛容な
// クライアントは通ってしまうので、ここは実値で固定する。
const WS_ACCEPT = createHash('sha1')
	.update(`${WS_KEY}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
	.digest('base64');

async function mount(config) {
	const mock = createMockCtx();
	const routes = new Map();
	const disposers = [];
	const ctx = {
		...mock.ctx,
		webServer: {
			port: 0,
			register: ({ path, handler }) => {
				routes.set(path, handler);
				return () => routes.delete(path);
			},
			registerUpgrade: ({ path, handler }) => {
				ctx.__upgrade = { path, handler };
				return () => {
					ctx.__upgrade = null;
				};
			},
		},
		effect: (setup) => {
			const dispose = setup();
			if (typeof dispose === 'function') disposers.push(dispose);
			return dispose;
		},
	};
	applyPlugin(ctx, config);
	await settle(4);
	return { ctx, routes, disposers };
}

async function serve(plugin) {
	const server = createServer(async (req, res) => {
		const path = (req.url ?? '/').split('?')[0];
		const handler = plugin.routes.get(path);
		if (!handler) {
			res.writeHead(404, { 'content-type': 'text/plain' }).end('not routed');
			return;
		}
		try {
			await handler(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'));
		} catch (error) {
			if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
			if (!res.writableEnded) res.end(String(error));
		}
	});

	server.on('upgrade', (req, socket, head) => {
		const upgrade = plugin.ctx.__upgrade;
		if (!upgrade || (req.url ?? '').split('?')[0] !== upgrade.path) {
			socket.destroy();
			return;
		}
		upgrade.handler(req, socket, head);
	});

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;
	const close = () =>
		new Promise((resolve) => {
			server.closeAllConnections?.();
			server.close(() => resolve());
		});
	return { port, close };
}

/** One buffer for the whole socket: the handshake and the first frame arrive in
 *  the same chunk, and splitting them across two readers silently drops frames. */
function reader(socket) {
	let buffer = Buffer.alloc(0);
	let handshake = null;
	const frames = [];
	const frameWaiters = [];
	let handshakeWaiter = null;

	const flushHandshake = () => {
		if (handshake !== null) return true;
		const end = buffer.indexOf('\r\n\r\n');
		if (end < 0) return false;
		handshake = buffer.subarray(0, end + 4).toString('latin1');
		buffer = buffer.subarray(end + 4);
		if (handshakeWaiter) handshakeWaiter(handshake);
		return true;
	};

	const pump = () => {
		if (!flushHandshake()) return;
		for (;;) {
			if (buffer.length < 2) return;
			const length7 = buffer[1] & 0x7f;
			let offset = 2;
			let length = length7;
			if (length7 === 126) {
				if (buffer.length < 4) return;
				length = buffer.readUInt16BE(2);
				offset = 4;
			} else if (length7 === 127) {
				if (buffer.length < 10) return;
				length = Number(buffer.readBigUInt64BE(2));
				offset = 10;
			}
			if (buffer.length < offset + length) return;
			const frame = {
				opcode: buffer[0] & 0x0f,
				payload: Buffer.from(buffer.subarray(offset, offset + length)),
			};
			buffer = buffer.subarray(offset + length);
			const waiter = frameWaiters.shift();
			if (waiter) waiter(frame);
			else frames.push(frame);
		}
	};

	socket.on('data', (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		pump();
	});
	socket.on('error', () => {});

	return {
		waitHandshake: () =>
			new Promise((resolve, reject) => {
				if (handshake !== null) return resolve(handshake);
				const timer = setTimeout(() => reject(new Error('no handshake within 5s')), 5000);
				handshakeWaiter = (value) => {
					clearTimeout(timer);
					resolve(value);
				};
			}),
		nextFrame: () =>
			new Promise((resolve, reject) => {
				if (frames.length > 0) return resolve(frames.shift());
				const timer = setTimeout(() => reject(new Error('no frame within 6s')), 6000);
				frameWaiters.push((frame) => {
					clearTimeout(timer);
					resolve(frame);
				});
			}),
	};
}

test('the stream upgrades, and each frame is a full v2 snapshot with a rising seq', { timeout: 25000 }, async () => {
	const plugin = await mount({ exposeOnHarness: true, basePath: '/andon' });
	const server = await serve(plugin);
	const socket = connect(server.port, '127.0.0.1');

	try {
		await new Promise((resolve) => socket.once('connect', resolve));
		const tap = reader(socket);
		socket.write(
			`GET /api/andon/stream HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n` +
				'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
				`Sec-WebSocket-Key: ${WS_KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
		);

		const handshake = await tap.waitHandshake();
		assert.match(handshake, /^HTTP\/1\.1 101 Switching Protocols/);
		// base64 is case-sensitive, and the header line ends with \r\n, so a `$`
		// anchored regex silently fails on the trailing CR. Plain containment.
		assert.ok(
			handshake.includes(`Sec-WebSocket-Accept: ${WS_ACCEPT}`),
			`the accept hash must be the RFC 6455 value (${WS_ACCEPT})`,
		);

		const first = JSON.parse((await tap.nextFrame()).payload.toString('utf8'));
		const second = JSON.parse((await tap.nextFrame()).payload.toString('utf8'));

		for (const snap of [first, second]) {
			assert.equal(snap.v, 2);
			assert.ok(Array.isArray(snap.sessions), 'every frame is a whole snapshot, not a delta');
			assert.ok(Number.isFinite(snap.serverTime));
		}
		assert.ok(second.seq > first.seq, `seq must rise: ${first.seq} → ${second.seq}`);
	} finally {
		socket.destroy();
		await server.close();
		for (const dispose of plugin.disposers) dispose();
	}
});

test('an ACK is recorded in the log and does not clear the state', { timeout: 25000 }, async () => {
	const plugin = await mount({ exposeOnHarness: true, basePath: '/andon' });
	const server = await serve(plugin);

	try {
		const before = await getJson(server.port, '/api/andon/state');
		const overallBefore = before.overall;

		const ack = await postJson(server.port, '/api/andon/ack', {
			seq: before.seq,
			overall: overallBefore,
			device: 'fire-tab',
		});
		assert.equal(ack.status, 200, `a well-formed ACK is accepted (got ${ack.status}: ${ack.body})`);

		const after = await getJson(server.port, '/api/andon/state');
		assert.ok(
			after.log.some((line) => line.text.includes('確認') && line.text.includes('fire-tab')),
			'the ACK leaves a line in the human log',
		);
		assert.equal(
			after.overall,
			overallBefore,
			'ACK must not clear the state — only the blink and the sound stop',
		);

		const bad = await postJson(server.port, '/api/andon/ack', { nope: true });
		assert.equal(bad.status, 400, 'a malformed body is a 400, not a crash');
	} finally {
		await server.close();
		for (const dispose of plugin.disposers) dispose();
	}
});

function call(port, path, method, body) {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{
				host: '127.0.0.1',
				port,
				path,
				method,
				headers: body ? { 'content-type': 'application/json' } : {},
			},
			(res) => {
				let data = '';
				res.setEncoding('utf8');
				res.on('data', (chunk) => (data += chunk));
				res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
			},
		);
		req.on('error', reject);
		if (body) req.write(body);
		req.end();
	});
}

async function getJson(port, path) {
	const res = await call(port, path, 'GET', null);
	assert.equal(res.status, 200, `GET ${path} → ${res.status}: ${res.body.slice(0, 120)}`);
	return JSON.parse(res.body);
}

function postJson(port, path, body) {
	return call(port, path, 'POST', JSON.stringify(body));
}
