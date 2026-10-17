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

describe('prohibited APIs in production source', () => {
  const root = process.cwd();
  const sourceDirs = [join(root, 'functions', 'src'), join(root, 'packages', 'contracts', 'src')];

  it('never uses Math.random for security-sensitive values', () => {
    const offenders: string[] = [];
    for (const directory of sourceDirs) {
      for (const file of listTypeScriptFiles(directory)) {
        const content = readFileSync(file, 'utf8');
        if (content.includes('Math.random')) {
          offenders.push(relative(root, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never uses non-keyed hashing for stored secrets (crypto.createHash)', () => {
    const offenders: string[] = [];
    for (const directory of sourceDirs) {
      for (const file of listTypeScriptFiles(directory)) {
        const content = readFileSync(file, 'utf8');
        if (content.includes('createHash(')) {
          offenders.push(relative(root, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
