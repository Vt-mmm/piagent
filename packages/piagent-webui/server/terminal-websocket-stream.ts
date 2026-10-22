import type { TerminalState, TerminalOutput, TerminalExit } from "../contracts/generated/terminal-v1.ts";
export type TerminalStreamMessage = TerminalState | TerminalOutput | TerminalExit;
export type TerminalStreamPort = {
  subscribe(sessionRef: string, listener: (message: TerminalStreamMessage) => void): () => void;
  replay(sessionRef: string): TerminalOutput[];
};

// Each socket follows one selected session. PTYs outlive this subscription.
export class TerminalWebSocketStream {
  readonly #port: TerminalStreamPort;
  readonly #authorized: (csrf: string) => boolean;
  readonly #send: (message: TerminalStreamMessage) => void;
  readonly #close: (reason: string) => void;
  #unsubscribe: (() => void) | null = null;
  #generation = 0;
  constructor(options: { port: TerminalStreamPort; authorized(csrf: string): boolean;
    send(message: TerminalStreamMessage): void; close(reason: string): void }) {
    this.#port = options.port; this.#authorized = options.authorized; this.#send = options.send; this.#close = options.close;
  }
  stop() { this.#generation++; this.#unsubscribe?.(); this.#unsubscribe = null; }
  begin(sessionRef: string, csrf: string) {
    this.stop();
    const generation = this.#generation;
    let pending: TerminalStreamMessage[] = [], bytes = 0, replaying = true;
    const deliver = (message: TerminalStreamMessage) => {
      if (generation !== this.#generation) return;
      if (!this.#authorized(csrf)) { this.stop(); this.#close("terminal-session-expired"); return; }
      this.#send(message);
    };
    this.#unsubscribe = this.#port.subscribe(sessionRef, message => {
      if (message.identity.sessionRef !== sessionRef || generation !== this.#generation) return;
      if (!this.#authorized(csrf)) { this.stop(); this.#close("terminal-session-expired"); return; }
      if (!replaying) { deliver(message); return; }
      bytes += Buffer.byteLength(JSON.stringify(message));
      if (bytes > 512 * 1024 || pending.length >= 256) { this.stop(); pending = []; this.#close("terminal-backpressure"); return; }
      pending.push(message);
    });
    return {
      // Called immediately after the state response, before accepting live data.
      finish: (ready: () => void) => {
        if (generation !== this.#generation) return;
        if (!this.#authorized(csrf)) { this.stop(); this.#close("terminal-session-expired"); return; }
        const replay = this.#port.replay(sessionRef), seen = new Map<string, number>();
        ready();
        for (const message of replay) { seen.set(message.terminalRef, message.sequence); deliver(message); }
        replaying = false;
        for (const message of pending) {
          if (message.messageType === "state" || message.messageType === "exit"
            || message.sequence > (seen.get(message.terminalRef) ?? -1)) deliver(message);
        }
        pending = [];
      },
      abort: () => { if (generation === this.#generation) this.stop(); }
    };
  }
}
