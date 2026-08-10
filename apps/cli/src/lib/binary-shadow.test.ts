import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectAgentsBinaryShadows } from './binary-shadow.js';

describe('detectAgentsBinaryShadows', () => {
  const savedPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = savedPath ?? '';
  });

  function withSystemPath(tmpDir: string): string {
    // Keep the platform resolver (`which` / `where`) available.
    return `${tmpDir}${path.delimiter}${savedPath ?? ''}`;
  }

  /** Long-form temp dir — Windows GHA TEMP is often the 8.3 short name. */
  function makeTmp(prefix: string): string {
    return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  }

  function binaryPath(tmpDir: string, name: string): string {
    return path.join(tmpDir, process.platform === 'win32' ? `${name}.cmd` : name);
  }

  function writeBinary(file: string, output: string): void {
    const contents = process.platform === 'win32'
      ? `@echo off\r\necho ${output}\r\n`
      : `#!/bin/sh\necho ${output}\n`;
    fs.writeFileSync(file, contents, { mode: 0o755 });
  }

  /** Path equality that tolerates Windows short (8.3) vs long forms. */
  function samePath(a: string, b: string): boolean {
    try {
      return fs.realpathSync.native(a) === fs.realpathSync.native(b);
    } catch {
      return process.platform === 'win32'
        ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
        : path.resolve(a) === path.resolve(b);
    }
  }

  it('returns empty when only the current agents binary exists', () => {
    const tmpDir = makeTmp('agents-shadow-one-');
    const agents = binaryPath(tmpDir, 'agents');
    writeBinary(agents, 'current');
    process.env.PATH = withSystemPath(tmpDir);
    try {
      expect(detectAgentsBinaryShadows(agents, [])).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects a shadowing binary earlier on PATH', () => {
    const tmpDir = makeTmp('agents-shadow-path-');
    const realAgents = binaryPath(tmpDir, 'real-agents');
    const shadowAgents = binaryPath(tmpDir, 'agents');
    writeBinary(realAgents, 'real');
    writeBinary(shadowAgents, 'shadow');
    process.env.PATH = withSystemPath(tmpDir);
    try {
      const shadows = detectAgentsBinaryShadows(realAgents, []);
      expect(shadows).toHaveLength(1);
      expect(samePath(shadows[0].path, shadowAgents)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects a latent shadow in a well-known install directory', () => {
    const tmpDir = makeTmp('agents-shadow-wellknown-');
    const realAgents = binaryPath(tmpDir, 'agents');
    const shadowDir = path.join(tmpDir, 'extra-bin');
    const shadowAgents = binaryPath(shadowDir, 'agents');
    writeBinary(realAgents, 'real');
    fs.mkdirSync(shadowDir, { recursive: true });
    writeBinary(shadowAgents, 'shadow');
    process.env.PATH = withSystemPath(tmpDir);
    try {
      const shadows = detectAgentsBinaryShadows(realAgents, [shadowDir]);
      expect(shadows.some((s) => samePath(s.path, shadowAgents))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
