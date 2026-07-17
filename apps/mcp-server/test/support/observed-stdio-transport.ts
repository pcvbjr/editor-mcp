import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export interface ObservedChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export class ObservedStdioTransport implements Transport {
  private readonly readBuffer = new ReadBuffer();
  private readonly childExitPromise: Promise<ObservedChildExit>;
  private resolveChildExit!: (exit: ObservedChildExit) => void;
  private child: ChildProcessWithoutNullStreams | undefined;
  private started = false;

  readonly errors: Error[] = [];
  readonly stderr: string[] = [];
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly cwd: string,
  ) {
    this.childExitPromise = new Promise<ObservedChildExit>((resolve) => {
      this.resolveChildExit = resolve;
    });
  }

  get childExit(): Promise<ObservedChildExit> {
    return this.childExitPromise;
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error('Observed stdio transport already started');
    }
    this.started = true;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.command, this.args, {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      child.once('spawn', resolve);
      child.once('error', (error) => {
        this.recordError(error);
        reject(error);
      });
      child.once('close', (code, signal) => {
        this.resolveChildExit({ code, signal });
        this.onclose?.();
      });
      child.stdout.on('data', (chunk: Buffer) => {
        this.readBuffer.append(chunk);
        this.processMessages();
      });
      child.stdout.on('error', (error) => {
        this.recordError(error);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        this.stderr.push(chunk.toString());
      });
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.child;
    if (child === undefined) {
      throw new Error('Observed stdio transport is not connected');
    }
    await new Promise<void>((resolve, reject) => {
      const serialized = serializeMessage(message);
      if (child.stdin.write(serialized)) {
        resolve();
        return;
      }
      child.stdin.once('drain', resolve);
      child.stdin.once('error', reject);
    });
  }

  async close(): Promise<void> {
    this.child?.stdin.end();
    await this.childExitPromise;
  }

  private processMessages(): void {
    let message = this.readBuffer.readMessage();
    while (message !== null) {
      try {
        this.onmessage?.(message);
      } catch (error: unknown) {
        this.recordError(error);
      }
      message = this.readBuffer.readMessage();
    }
  }

  private recordError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.errors.push(normalized);
    this.onerror?.(normalized);
  }
}
