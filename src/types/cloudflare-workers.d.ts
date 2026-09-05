declare module "cloudflare:workers" {
  export type SqlStorageValue = ArrayBuffer | string | number | null;

  export interface SqlStorageCursor<T> extends Iterable<T> {
    toArray(): T[];
    one(): T;
  }

  export interface SqlStorage {
    exec<T = Record<string, SqlStorageValue>>(
      query: string,
      ...bindings: SqlStorageValue[]
    ): SqlStorageCursor<T>;
  }

  export interface DurableObjectState {
    storage: { sql: SqlStorage };
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  }

  export class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}
