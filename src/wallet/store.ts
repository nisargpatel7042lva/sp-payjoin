/** Tiny JSON file persistence for the CLI wallets (regtest keys only — not a secure keystore). */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const walletPath = (name: string, dir = process.env.SPAY_HOME ?? resolve(process.env.HOME ?? '.', '.spay')) => resolve(dir, `${name}.json`);

export function loadJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
