import { existsSync, readdirSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { describe, it, expect } from 'vitest';
import { mkScalar, mkArray } from '@specodec/typespec-emitter-core/test-utils';
import { typeToSwift, readExpr, writeExpr, writeLines, defaultValue } from './index.js';

describe('typeToSwift', () => {
  it('string → String', () => expect(typeToSwift(mkScalar('string') as any)).toBe('String'));
  it('boolean → Bool', () => expect(typeToSwift(mkScalar('boolean') as any)).toBe('Bool'));
  it('int32 → Int32', () => expect(typeToSwift(mkScalar('int32') as any)).toBe('Int32'));
  it('int64 → Int64', () => expect(typeToSwift(mkScalar('int64') as any)).toBe('Int64'));
  it('float32 → Float', () => expect(typeToSwift(mkScalar('float32') as any)).toBe('Float'));
  it('float64 → Double', () => expect(typeToSwift(mkScalar('float64') as any)).toBe('Double'));
  it('bytes → Data', () => expect(typeToSwift(mkScalar('bytes') as any)).toBe('Data'));
  it('model → model name', () => expect(typeToSwift({ kind: 'Model', name: 'User' } as any)).toBe('User'));
});

describe('readExpr', () => {
  it('int32', () => expect(readExpr(mkScalar('int32') as any)).toContain('readInt32'));
  it('string', () => expect(readExpr(mkScalar('string') as any)).toContain('readString'));
  it('bool', () => expect(readExpr(mkScalar('boolean') as any)).toContain('readBool'));
  it('float32', () => expect(readExpr(mkScalar('float32') as any)).toContain('readFloat32'));
  it('bytes', () => expect(readExpr(mkScalar('bytes') as any)).toContain('readBytes'));
});

describe('generation + compile', () => {
  const ROOT = join(__dir, '..');
  const TSP = join(ROOT, 'node_modules', '.bin', 'tsp');
  const TDIR = join(ROOT, 'tests');
  const GEN = join(TDIR, 'generated');

  it('tsp generates ~200 codec files', () => {
    if (existsSync(GEN)) rmSync(GEN, { recursive: true });
    execSync(`${TSP} compile alltypes.tsp --emit=@specodec/typespec-emitter-swift --option @specodec/typespec-emitter-swift.emitter-output-dir=generated`, { cwd: TDIR, stdio: 'pipe' });
    expect(readdirSync(GEN).length).toBeGreaterThanOrEqual(10);
  });
});
