/**
 * The level-1 tutorial.
 *
 * Rules it follows, because a tower-defence tutorial is very easy to get wrong:
 *   - one instruction on screen at a time, never more than two lines
 *   - it never blocks input and never pauses the game
 *   - every step completes by the player *doing the thing*, not by a timer
 *   - it is skippable in one click, and it never runs twice (save.seenTutorial)
 *
 * Steps are polled against real game state rather than subscribed to events, so it stays
 * correct no matter which module ends up emitting what.
 */

const STEPS = [
  {
    id: 'build',
    title: 'Open build mode',
    body: 'Press <kbd>TAB</kbd>, or click a trap on the bar below.',
    anchor: 'bar',
    done: (g) => g.traps?.buildMode === true,
  },
  {
    id: 'place',
    title: 'Trap the corridor',
    body: 'Click a floor tile in the hallway to place it. <kbd>R</kbd> rotates, right-click sells.',
    anchor: 'centre',
    done: (g) => (g.traps?.list?.length ?? 0) > 0,
  },
  {
    id: 'more',
    title: 'Layer a second one',
    body: 'One trap is a speed bump. Place another so the gap between them stays short.',
    anchor: 'centre',
    done: (g) => (g.traps?.list?.length ?? 0) > 1,
  },
  {
    id: 'start',
    title: 'Send them in',
    body: 'Press <kbd>ENTER</kbd> when the corridor is ready. Waves never start on their own.',
    anchor: 'bar',
    done: (g) => g.director?.running === true || (g.director?.waveIndex ?? -1) >= 0,
  },
  {
    id: 'fight',
    title: 'Finish the leakers',
    body: 'Hold <kbd>LMB</kbd> to fire, <kbd>SPACE</kbd> to dodge. Chain kills to raise the multiplier.',
    anchor: 'bar',
    // Combat is a feel, not a checkbox: give it a few kills or a few seconds, whichever first.
    done: (g, t) => (g.scoring?.kills ?? 0) >= 3 || t > 9,
  },
];

export class Tutorial {
  constructor(game, el) {
    this.game = game;
    this.el = el;
    this.active = false;
    this.index = 0;
    this.stepTime = 0;
    this._holdOff = 0;
  }

  /** Only level 1, only once, and never if the player already knows. */
  maybeStart(levelIndex) {
    if (levelIndex !== 0 || this.game.save?.data?.seenTutorial) { this.stop(); return; }
    this.active = true;
    this.index = 0;
    this.stepTime = 0;
    this._holdOff = 0.6;   // let the level banner land first
    this._render();
  }

  stop(finished = false) {
    this.active = false;
    this.el.classList.add('hidden');
    if (finished && this.game.save?.data) {
      this.game.save.data.seenTutorial = true;
      this.game.save.flush();
    }
  }

  skip() {
    if (!this.active) return;
    this.stop(true);
    this.game.ui?.toast('Tutorial skipped. Press TAB to build.', 'info');
  }

  update(dt) {
    if (!this.active) return;
    if (this._holdOff > 0) {
      this._holdOff -= dt;
      if (this._holdOff <= 0) this._render();
      return;
    }
    const step = STEPS[this.index];
    if (!step) { this.stop(true); return; }
    this.stepTime += dt;
    // Never nag about something the player has already moved past: if a *later* step is
    // satisfied (they started the wave without laying a second trap), skip ahead rather
    // than telling them to build while orcs are on the field.
    const ranAhead = STEPS.some((s, i) => i > this.index && s.done(this.game, 0));
    if (step.done(this.game, this.stepTime) || ranAhead) {
      this.index++;
      this.stepTime = 0;
      if (this.index >= STEPS.length) {
        this.stop(true);
        this.game.ui?.toast('That is the whole game. Now make it a slaughterhouse.', 'good', 4200);
        return;
      }
      this.game.audio?.play?.('ui.confirm', { gain: 0.35 });
      this._render();
    }
  }

  _render() {
    const step = STEPS[this.index];
    if (!this.active || !step || this._holdOff > 0) { this.el.classList.add('hidden'); return; }
    this.el.className = `tutorial anchor-${step.anchor}`;
    this.el.innerHTML = `
      <div class="tut-rail">${STEPS.map((s, i) =>
        `<i class="tut-dot ${i < this.index ? 'done' : i === this.index ? 'now' : ''}"></i>`).join('')}</div>
      <div class="tut-body">
        <div class="tut-title">${step.title}</div>
        <div class="tut-text">${step.body}</div>
      </div>
      <button class="tut-skip" data-action="tut-skip" title="Skip the tutorial">SKIP</button>`;
  }
}
