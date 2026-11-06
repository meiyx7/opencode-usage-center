/**
 * The server half runs inside OpenCode's Bun process. Only the read-only surface
 * this plugin uses is declared, so the package does not need bun-types next to
 * @types/node.
 */
declare module "bun:sqlite" {
  export interface QueryResult<T> {
    all(...params: unknown[]): T[]
    get(...params: unknown[]): T | null
    run(...params: unknown[]): unknown
  }

  export class Database {
    constructor(path: string, options?: { readonly?: boolean; create?: boolean; readwrite?: boolean })
    query<T = Record<string, unknown>>(sql: string): QueryResult<T>
    close(): void
  }
}
