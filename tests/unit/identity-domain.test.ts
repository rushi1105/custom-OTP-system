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
 * Phase 3.1 boundary: the identity domain layer must contain no Firebase
 * operations — it talks only to the AuthPort / IdentityStore ports. Firebase
 * adapters arrive in subphase 3.2+ outside `functions/src/identity/**` where a
 * Firebase dependency is expected.
 */
describe('identity domain layer boundaries (subphase 3.1)', () => {
  const root = process.cwd();
  const identityDir = join(root, 'functions', 'src', 'identity');

  it('contains no firebase-admin, firebase-functions, or Firestore adapter imports', () => {
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

  it('performs no account creation or token minting outside the port declaration', () => {
    const forbiddenCalls = ['createCustomToken(', 'createUserWithPhone('];
    const offenders: string[] = [];
    for (const file of listTypeScriptFiles(identityDir)) {
      const name = file.replace(/\\/g, '/');
      if (name.endsWith('/types.ts')) {
        continue; // sole allowed declaration site: the AuthPort interface
      }
      const content = readFileSync(file, 'utf8');
      if (forbiddenCalls.some((call) => content.includes(call))) {
        offenders.push(relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
