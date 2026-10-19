import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

function listTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...listTypeScriptFiles(fullPath));
    } else if (entry.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Identity-domain boundaries: the domain talks only to the AuthPort /
 * IdentityStore ports. Firebase imports are confined to the infrastructure
 * adapters under `functions/src/auth/**`. Token minting is absent until 3.4.
 */
describe('identity domain and Auth adapter boundaries', () => {
  const root = process.cwd();
  const identityDir = join(root, 'functions', 'src', 'identity');
  const authDir = join(root, 'functions', 'src', 'auth');

  it('contains no firebase-admin, firebase-functions, or Firestore adapter imports in the identity domain', () => {
    const offenders: string[] = [];
    for (const file of listTypeScriptFiles(identityDir)) {
      const content = readFileSync(file, 'utf8');
      if (
        content.includes('firebase-admin') ||
        content.includes('firebase-functions') ||
        content.includes('firestore-database')
      ) {
        offenders.push(relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares account creation only in the identity port (no implementation yet)', () => {
    const offenders: string[] = [];
    for (const file of listTypeScriptFiles(identityDir)) {
      const name = file.replace(/\\/g, '/');
      if (name.endsWith('/types.ts')) {
        continue; // sole allowed declaration site: the AuthPort interface
      }
      if (readFileSync(file, 'utf8').includes('createUserWithPhone(')) {
        offenders.push(relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('contains no custom-token minting in the identity domain or Auth adapter', () => {
    const offenders: string[] = [];
    for (const directory of [identityDir, authDir]) {
      for (const file of listTypeScriptFiles(directory)) {
        if (readFileSync(file, 'utf8').includes('createCustomToken')) {
          offenders.push(relative(root, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps logging out of the Firebase Auth adapter', () => {
    const adapter = join(authDir, 'firebase-auth-port.ts');
    const content = readFileSync(adapter, 'utf8');
    expect(content).not.toMatch(/console\.(log|info|warn|error|debug)/);
    expect(content).not.toMatch(/\bLogger\b/);
    expect(content).not.toContain('createCustomToken');
  });
});
