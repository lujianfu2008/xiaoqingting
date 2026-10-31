import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

// Push-based async iterable used as the streaming input for query().
export class TurnQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private resolvers: Array<(r: IteratorResult<SDKUserMessage>) => void> = [];
  private ended = false;

  push(text: string): void {
    const msg: SDKUserMessage = {
      type: "user",
      session_id: " ",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    };
    const r = this.resolvers.shift();
    if (r) r({ value: msg, done: false });
    else this.items.push(msg);
  }

  end(): void {
    this.ended = true;
    for (const r of this.resolvers.splice(0)) r({ value: undefined, done: true });
  }

  /** 已排队但引擎尚未消费的消息数；0 表示引擎处于回合间空闲。 */
  get pending(): number {
    return this.items.length;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}
