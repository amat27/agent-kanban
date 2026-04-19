import * as pty from "node-pty";

import {
	buildWindowsCmdArgsCommandLine,
	resolveWindowsComSpec,
	shouldUseWindowsCmdLaunch,
} from "../core/windows-cmd-launch";
import { resolveBinaryOnPath } from "./command-discovery";

export interface PtyExitEvent {
	exitCode: number;
	signal?: number;
}

export interface SpawnPtySessionRequest {
	binary: string;
	args?: string[] | string;
	cwd: string;
	env?: Record<string, string | undefined>;
	cols: number;
	rows: number;
	onData?: (chunk: Buffer) => void;
	onExit?: (event: PtyExitEvent) => void;
}

type PtyOutputChunk = string | Buffer | Uint8Array;

function normalizeOutputChunk(data: PtyOutputChunk): Buffer {
	if (typeof data === "string") {
		return Buffer.from(data, "utf8");
	}
	return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function isIgnorablePtyWriteError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return code === "EIO" || code === "EBADF";
}

function isIgnorablePtyResizeError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "EIO" || code === "EBADF") {
		return true;
	}
	return error.message.toLowerCase().includes("already exited");
}

function terminatePtyProcess(ptyProcess: pty.IPty): void {
	const pid = ptyProcess.pid;
	ptyProcess.kill();
	if (process.platform !== "win32" && Number.isFinite(pid) && pid > 0) {
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			// Best effort: process group may already be gone or inaccessible.
		}
	}
}

function isAbsoluteOrRelativePath(binary: string): boolean {
	return /[\\/]/.test(binary);
}

function isCmdBinary(binary: string): boolean {
	const normalized = binary.trim().toLowerCase();
	return normalized === "cmd" || normalized === "cmd.exe";
}

export class PtySession {
	private readonly ptyProcess: pty.IPty;
	private interrupted = false;
	private exited = false;

	private constructor(
		ptyProcess: pty.IPty,
		private readonly onDataCallback?: (chunk: Buffer) => void,
		private readonly onExitCallback?: (event: PtyExitEvent) => void,
	) {
		this.ptyProcess = ptyProcess;
		(this.ptyProcess.onData as unknown as (listener: (data: PtyOutputChunk) => void) => void)((data) => {
			const chunk = normalizeOutputChunk(data);
			this.onDataCallback?.(chunk);
		});
		this.ptyProcess.onExit((event) => {
			this.exited = true;
			this.onExitCallback?.(event);
		});
	}

	static spawn({ binary, args = [], cwd, env, cols, rows, onData, onExit }: SpawnPtySessionRequest): PtySession {
		const normalizedArgs = typeof args === "string" ? [args] : args;
		const terminalName = env?.TERM?.trim() || process.env.TERM?.trim() || "xterm-256color";
		const launchEnv: NodeJS.ProcessEnv = env ? { ...process.env, ...env } : process.env;
		const useWindowsShellLaunch = shouldUseWindowsCmdLaunch(binary, process.platform, launchEnv);
		let spawnBinary = useWindowsShellLaunch ? resolveWindowsComSpec(launchEnv) : binary;
		const spawnArgs = useWindowsShellLaunch ? buildWindowsCmdArgsCommandLine(binary, normalizedArgs) : normalizedArgs;
		// node-pty's Windows conpty backend does not perform PATH resolution on the
		// executable name (unlike Node's child_process.spawn). Passing a bare command
		// like "opencode" produces the cryptic `File not found:` error even when the
		// binary is on PATH. Resolve to an absolute path here so direct .exe launches
		// work the same as cmd.exe-mediated .cmd launches. Skip when the binary is
		// already an absolute/relative path or is cmd itself (conpty already locates
		// cmd via its own startup logic; resolving via PATH would be redundant churn).
		if (
			process.platform === "win32" &&
			!useWindowsShellLaunch &&
			!isAbsoluteOrRelativePath(binary) &&
			!isCmdBinary(binary)
		) {
			// Try the merged launch environment first, then fall back to the Kanban
			// process's own PATH. The two can diverge: callers sometimes hand us a
			// scrubbed env (e.g. for hook isolation) that drops user-installed shim
			// directories like Scoop's, even though Kanban itself was launched from
			// a shell that has them on PATH. Leaving spawnBinary as the bare name in
			// the unresolved case lets node-pty surface its own error, which the
			// session manager already wraps into a user-facing failure message.
			const resolved = resolveBinaryOnPath(binary, launchEnv) ?? resolveBinaryOnPath(binary, process.env);
			if (resolved) {
				spawnBinary = resolved;
			}
		}
		const ptyOptions: pty.IPtyForkOptions = {
			name: terminalName,
			cwd,
			env,
			cols,
			rows,
			encoding: null,
		};

		const ptyProcess = pty.spawn(spawnBinary, spawnArgs, ptyOptions);
		return new PtySession(ptyProcess, onData, onExit);
	}

	get pid(): number {
		return this.ptyProcess.pid;
	}

	write(data: string | Buffer): void {
		try {
			this.ptyProcess.write(typeof data === "string" ? data : data.toString("utf8"));
		} catch (error) {
			if (isIgnorablePtyWriteError(error)) {
				return;
			}
			throw error;
		}
	}

	resize(cols: number, rows: number, pixelWidth?: number, pixelHeight?: number): void {
		if (this.exited) {
			return;
		}
		try {
			if (pixelWidth !== undefined && pixelHeight !== undefined) {
				this.ptyProcess.resize(cols, rows, {
					width: pixelWidth,
					height: pixelHeight,
				});
				return;
			}
			this.ptyProcess.resize(cols, rows);
		} catch (error) {
			if (isIgnorablePtyResizeError(error)) {
				this.exited = true;
				return;
			}
			throw error;
		}
	}

	pause(): void {
		this.ptyProcess.pause();
	}

	resume(): void {
		this.ptyProcess.resume();
	}

	stop(options?: { interrupted?: boolean }): void {
		if (options?.interrupted) {
			this.interrupted = true;
		}
		terminatePtyProcess(this.ptyProcess);
	}

	wasInterrupted(): boolean {
		return this.interrupted;
	}
}
