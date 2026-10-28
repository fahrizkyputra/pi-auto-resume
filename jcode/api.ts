/**
 * A minimal client for jcode's harness API (protocol v1, NDJSON over a Unix
 * socket served by `jcode api-bridge`). Only what auto-resume needs:
 * hello, list_sessions, attach_session, send_message, and the event stream.
 *
 * Written against @1jehuang/jcode-sdk 1.2.0 (sdk/typescript/src/client.ts)
 * instead of depending on it: the jcode side is copied out of node_modules
 * at install time, and the SDK would pull in ajv and a bundled runtime.
 */

import { createConnection, type Socket } from "node:net";

export const API_VERSION = 1;

export interface Frame {
	ev?: string;
	reply_to?: number;
	session_id?: string;
	[key: string]: unknown;
}

export interface SessionInfo {
	session_id: string;
	status?: string;
	user_connected?: boolean;
	working_dir?: string;
	title?: string;
}

/** The byte stream a client runs on; a socket in production, a fake in tests. */
export interface Transport {
	write(line: string): void;
	onData(listener: (chunk: string) => void): void;
	onClose(listener: () => void): void;
	close(): void;
}

export function socketTransport(path: string): Promise<Transport> {
	return new Promise((resolve, reject) => {
		const socket: Socket = createConnection(path);
		socket.once("error", reject);
		socket.once("connect", () => {
			socket.removeListener("error", reject);
			socket.on("error", () => {});
			socket.setEncoding("utf8");
			resolve({
				write: (line) => {
					if (!socket.destroyed) socket.write(line);
				},
				onData: (listener) => socket.on("data", (chunk: string) => listener(chunk)),
				onClose: (listener) => socket.once("close", () => listener()),
				close: () => socket.destroy(),
			});
		});
	});
}

export class ApiClient {
	private nextId = 1;
	private buffer = "";
	private waiters = new Map<number, { resolve: (frame: Frame) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private listeners = new Set<(frame: Frame) => void>();
	private closeListeners = new Set<() => void>();
	closed = false;

	private readonly transport: Transport;
	private readonly timeoutMs: number;

	constructor(transport: Transport, timeoutMs = 15_000) {
		this.transport = transport;
		this.timeoutMs = timeoutMs;
		transport.onData((chunk) => this.ingest(chunk));
		transport.onClose(() => {
			this.closed = true;
			for (const [, waiter] of this.waiters) {
				clearTimeout(waiter.timer);
				waiter.reject(new Error("connection closed"));
			}
			this.waiters.clear();
			for (const listener of this.closeListeners) listener();
		});
	}

	static async connect(socketPath: string, clientName: string): Promise<ApiClient> {
		const client = new ApiClient(await socketTransport(socketPath));
		await client.hello(clientName);
		return client;
	}

	async hello(clientName: string): Promise<Frame> {
		const reply = await this.request({ req: "hello", min_version: API_VERSION, max_version: API_VERSION, client: clientName, supports_user_response: false });
		if (reply.ev !== "hello_ok") throw new Error(`handshake failed: ${reply.ev}`);
		return reply;
	}

	onEvent(listener: (frame: Frame) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onClose(listener: () => void): void {
		this.closeListeners.add(listener);
	}

	request(body: Record<string, unknown>): Promise<Frame> {
		if (this.closed) return Promise.reject(new Error("connection closed"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters.delete(id);
				reject(new Error(`no reply to ${String(body.req)} within ${this.timeoutMs}ms`));
			}, this.timeoutMs);
			timer.unref?.();
			this.waiters.set(id, { resolve, reject, timer });
			this.transport.write(`${JSON.stringify({ v: API_VERSION, id, ...body })}\n`);
		});
	}

	private async requestOk(body: Record<string, unknown>): Promise<Frame> {
		const reply = await this.request(body);
		if (reply.ev === "error") throw new Error(`${String(reply.code)}: ${String(reply.message)}`);
		return reply;
	}

	async listSessions(limit = 50): Promise<SessionInfo[]> {
		const reply = await this.requestOk({ req: "list_sessions", limit });
		return (reply.sessions as SessionInfo[] | undefined) ?? [];
	}

	async attachSession(sessionId: string): Promise<SessionInfo> {
		const reply = await this.requestOk({ req: "attach_session", session_id: sessionId });
		return reply.session as SessionInfo;
	}

	/** Fire-and-forget, as the SDK does; acceptance arrives as a `message_accepted` event. */
	sendMessage(sessionId: string, content: string): void {
		if (this.closed) throw new Error("connection closed");
		this.transport.write(`${JSON.stringify({ v: API_VERSION, id: this.nextId++, req: "send_message", session_id: sessionId, content, images: [] })}\n`);
	}

	close(): void {
		this.transport.close();
	}

	private ingest(chunk: string): void {
		this.buffer += chunk;
		let index = this.buffer.indexOf("\n");
		while (index >= 0) {
			const line = this.buffer.slice(0, index).trim();
			this.buffer = this.buffer.slice(index + 1);
			index = this.buffer.indexOf("\n");
			if (line === "") continue;
			let frame: Frame;
			try {
				frame = JSON.parse(line) as Frame;
			} catch {
				continue;
			}
			const waiter = typeof frame.reply_to === "number" ? this.waiters.get(frame.reply_to) : undefined;
			if (waiter && typeof frame.reply_to === "number") {
				this.waiters.delete(frame.reply_to);
				clearTimeout(waiter.timer);
				waiter.resolve(frame);
				continue;
			}
			for (const listener of this.listeners) listener(frame);
		}
	}
}
