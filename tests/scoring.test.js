import { describe, it, expect } from 'vitest';
import { Scoring } from '../src/director/Scoring.js';
import { stubGame } from './helpers.js';

function run(ids) {
  const g = stubGame();
  const s = new Scoring(g);
  ids.forEach((trapId, i) => {
    g.clock.elapsed = i * 2;   // spaced out so multi-kill never fires
    g.bus.emit('enemy:killed', {
      enemy: { def: { score: 100 }, has: () => false, flagSet: new Set(), resist: null, id: 'orc-grunt', position: { x: 0, y: 0, z: 0 } },
      byTrap: true, trapId, position: { x: 0, y: 0, z: 0 },
    });
  });
  return s;
}

describe('Scoring trap chain', () => {
  it('three different traps pay the chain bonus', () => {
    expect(run(['a', 'b', 'c'])._chain).toEqual([]);   // paid out and reset
  });

  it('A-B-A is two traps and does not pay', () => {
    const s = run(['a', 'b', 'a']);
    expect(s._chain).toEqual(['a']);                    // the repeat restarts the chain
    expect(s.score).toBeLessThan(run(['a', 'b', 'c']).score);
  });
});
