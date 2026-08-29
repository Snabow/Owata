import { randomUUID } from "node:crypto";

export function newId(prefix?: string): string {
  const id = randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

export function nowIso(clock: () => Date = () => new Date()): string {
  return clock().toISOString();
}
