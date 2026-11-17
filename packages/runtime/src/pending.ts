import { randomUUID } from "node:crypto";
import { ExecutorError } from "@agentbridgelens/protocol";

/** Each reply is bound to its originating socket/process. No automatic retries. */
export class PendingRequests {
  private items = new Map<
    string,
    {
      owner: object;
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      cleanup: () => void;
    }
  >();
  get size() {
    return this.items.size;
  }
  create(
    owner: object,
    options: {
      timeoutMs: number;
      signal?: AbortSignal;
      onCancel?: (id: string) => void;
      onTimeout?: () => void;
      timeoutMessage?: string;
    },
  ) {
    const id = randomUUID();
    const promise = new Promise<any>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const abort = () => {
        if (!this.items.has(id)) return;
        options.onCancel?.(id);
        this.settle(
          owner,
          id,
          new ExecutorError(
            "CANCELLED",
            "Request cancelled; an action may already have occurred. Observe before retrying.",
          ),
        );
      };
      this.items.set(id, {
        owner,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
        },
      });
      timer = setTimeout(() => {
        if (!this.items.has(id)) return;
        options.onCancel?.(id);
        this.settle(
          owner,
          id,
          new ExecutorError(
            "TIMEOUT",
            options.timeoutMessage ??
              "Executor timed out; action outcome may be unknown. Observe before retrying.",
          ),
        );
        options.onTimeout?.();
      }, options.timeoutMs);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    });
    return { id, promise };
  }
  has(owner: object, id: string) {
    return this.items.get(id)?.owner === owner;
  }
  settle(owner: object, id: string, error?: Error, result?: unknown) {
    const item = this.items.get(id);
    if (!item || item.owner !== owner) return false;
    this.items.delete(id);
    item.cleanup();
    if (error) item.reject(error);
    else item.resolve(result);
    return true;
  }
  rejectOwner(owner: object, error: Error) {
    for (const [id, item] of this.items)
      if (item.owner === owner) this.settle(owner, id, error);
  }
  rejectAll(error: Error) {
    for (const [id, item] of this.items) this.settle(item.owner, id, error);
  }
}
