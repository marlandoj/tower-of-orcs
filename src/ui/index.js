import { getTrapDef } from '../traps/roster.js';
import { LEVELS } from '../world/LevelDefs.js';
import { trapIcon, trapAccent, surfaceIcon, threatIcon, skullRow, COIN, SKULL, LOCK, DIVIDER, GATE } from './icons.js';
import { readThreat, trapAnswers, trapCadence } from './threat.js';
import { renderSpellbook, tierOf, upgrade, respec, earnedSkulls, esc } from './spellbook.js';
import { renderSettings, readSetting, writeSetting, applyAllSettings, SETTINGS, pct } from './settings.js';
import { renderResults } from './results.js';
import { renderWeapons, syncWeapons, renderSpells, syncSpells, renderSkills } from './loadout.js';
import { Minimap } from './minimap.js';
import { Tutorial } from './tutorial.js';
import { MenuNav } from './nav.js';

/**
 * All HUD and menus. DOM rather than in-canvas: crisp text at any resolution, free
 * layout, and it costs the renderer nothing.
 *
 * Two rules shape the layout:
 *   1. The middle of the screen is the game. Every HUD element is pinned to an edge and
 *      the transient banner sits in the upper third — nothing ever sits over the fight.
 *   2. During a wave the HUD answers exactly three questions: how is the rift, what is
 *      coming, what can I afford. Everything else is build-phase furniture and hides.
 *
 * Pointer events are off for the whole HUD and re-enabled only on things you click, so a
 * full-width top bar never eats a shot aimed at the corridor behind it.
 */

/** Every overlay screen, in the order they stack. */
const OVERLAYS = ['title', 'levelSelect', 'howto', 'settings', 'spellbook', 'skills', 'armoury', 'results', 'pause'];
/** Screens ESC can back out of. `results` and `title` deliberately are not among them. */
const BACKABLE = ['levelSelect', 'howto', 'settings', 'spellbook', 'skills'];

export class UI {
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('ui-root');
    this.phase = 'menu';
    this._stack = [];
    this._current = null;
    this._tipFor = null;
    this._build();
    this.tutorial = new Tutorial(game, this.el.tutorial);
    this.nav = new MenuNav(this.root, () => this._back());
    this.minimap = new Minimap(game, this.el.mmBody);
    this._inspectFor = null;
    this._holdFire = 0;
    this._wire();
    applyAllSettings(game);
  }

  // ------------------------------------------------------------------ markup
  _build() {
    this.root.insertAdjacentHTML('beforeend', `
      <div id="hud" class="hidden" data-phase="build">
        <div class="hud-top">
          <div class="plaque rift-plaque" id="rift-plaque">
            <div class="pl-label">RIFT</div>
            <div class="rift-gauge"><div class="rift-fill" id="rift-fill"></div></div>
            <div class="rift-value" id="rift-value">20</div>
          </div>

          <div class="plaque wave-plaque">
            <div class="wave-label" id="wave-label">WAVE 1 / 4</div>
            <div class="wave-sub" id="wave-sub">BUILD PHASE</div>
            <div class="wave-pips" id="wave-pips"></div>
          </div>

          <div class="plaque score-plaque">
            <div class="coin-row"><span class="ico coin-ico">${COIN}</span><span class="coin" id="coin">0</span></div>
            <div class="score-row"><span class="score-label">SCORE</span><span class="score" id="score">0</span></div>
          </div>
        </div>

        <div class="hud-left">
          <div class="remaining hidden" id="remaining"></div>
          <div class="threat panel hidden" id="threat"></div>
          <div class="toasts" id="toasts"></div>
        </div>

        <div class="hud-right">
          <div class="combo" id="combo"></div>
          <div class="combo-feed" id="combo-feed"></div>
          <div class="inspect hidden" id="inspect"></div>
        </div>

        <div class="minimap" id="minimap">
          <div class="mm-head">
            <span class="mm-title">THE HALL</span>
            <span class="mm-lanes" id="mm-lanes"></span>
          </div>
          <div class="mm-body" id="mm-body"></div>
          <div class="mm-legend">
            <span class="mk route"></span>route
            <span class="mk gate"></span>door
            <span class="mk rift"></span>rift
            <kbd>M</kbd>
          </div>
        </div>

        <div class="hud-bottom">
          <div class="bot-left">
            <div class="kit">
              <div class="weapons" id="weapons"></div>
              <div class="weapon-line">
                <span class="weapon" id="weapon-name">Arcane Crossbow</span>
                <span class="wp-hint" id="weapon-hint"></span>
              </div>
              <div class="vitals">
                <div class="vital hp"><div class="vital-fill" id="hp-fill"></div><span class="vital-text" id="hp-text">150</span></div>
                <div class="vital mana"><div class="vital-fill" id="mana-fill"></div><span class="vital-text sm" id="mana-text"></span></div>
              </div>
              <div class="spells" id="spells"></div>
            </div>
          </div>

          <div class="bot-mid">
            <div class="tutorial hidden" id="tutorial"></div>
            <div class="phase-cta" id="phase-cta"></div>
            <div class="trapbar" id="trapbar"></div>
          </div>

          <div class="bot-right">
            <div class="hint-strip" id="hint-strip"></div>
          </div>
        </div>

        <div class="banner" id="banner"></div>
        <div class="trap-tip hidden" id="trap-tip"></div>
      </div>

      <div id="title-screen" class="overlay screen-title">
        <div class="title-art">
          <div class="title-crest">${crest()}</div>
          <h1>TOWER<span>of</span>ORCS</h1>
          <div class="filigree">${DIVIDER}</div>
          <p class="tagline">They are coming for the rift. Make the hallway a slaughterhouse.</p>
        </div>
        <div class="menu column">
          <button class="btn primary" data-action="play">CAMPAIGN</button>
          <button class="btn" data-action="levels">LEVEL SELECT</button>
          <button class="btn" data-action="spellbook">SPELLBOOK</button>
          <button class="btn" data-action="skills">SKILLS</button>
          <button class="btn" data-action="settings">SETTINGS</button>
          <button class="btn" data-action="howto">HOW TO PLAY</button>
        </div>
        <div class="credits">WASD move / face travel · Middle-drag orbit / aim · LMB fire · RMB melee · SPACE dodge · Q weapon · F/C/V spells · TAB build · 1–9 traps · M map · ENTER start wave</div>
      </div>

      <div id="level-select" class="overlay hidden">
        <div class="sheet wide">
          <div class="sheet-head">
            <h2 class="ornate">CHOOSE YOUR STAND</h2>
            <div class="purse-line"><span class="sk">${SKULL}</span><span id="ls-skulls">0</span> skulls earned</div>
          </div>
          <div class="level-grid scroll-y" id="level-grid"></div>
          <div class="menu"><button class="btn primary" data-action="back">BACK</button></div>
        </div>
      </div>

      <div id="howto" class="overlay hidden">
        <div class="sheet">
          <div class="sheet-head"><h2 class="ornate">HOW TO PLAY</h2></div>
          <div class="howto-body scroll-y">
            <section><h3>Follow camera</h3>
              <p>WASD moves and turns the mage toward travel, relative to the camera. Hold the
                 middle mouse button to aim camera-forward and drag to orbit. Attacks follow your facing.
                 Scroll to zoom and use <kbd>[</kbd> / <kbd>]</kbd> to tilt.
                 In build mode, move the cursor to choose a tile.</p></section>
            <section><h3>Build, then fight</h3>
              <p>Between waves press <kbd>TAB</kbd> or click a trap to enter build mode. Click a tile to
                 place, <kbd>R</kbd> to rotate, right-click to sell for 70%. Nothing starts until you press
                 <kbd>ENTER</kbd>.</p></section>
            <section><h3>Traps do the work</h3>
              <p>Your crossbow will never out-damage a good corridor. It finishes the runners that slip
                 through — and every kill you land keeps the combo alive.</p></section>
            <section><h3>Every orc is a question</h3>
              <p>Armour beats arrows. Flyers beat floors. Sappers eat your front row. The wave panel on the
                 left tells you which questions are coming; layer answers instead of stacking one trap.</p></section>
            <section><h3>Doors, not orcs</h3>
              <p>Difficulty is <em>how many corridors are open</em>, because a defence is priced per
                 corridor. The wave panel says how many doors this wave opens; the map in the corner
                 shows which, and traces the exact route the horde will walk. Press <kbd>M</kbd> to
                 hide it.</p></section>
            <section><h3>Barricades author the path</h3>
              <p>The Barricade does no damage — it closes a tile, and six lanes become one. Twelve
                 at a time, and never enough to seal the rift off. Sappers and ogres come for it
                 first, so watch its health, and it falls on whatever broke it.</p></section>
            <section><h3>Upgrade what already works</h3>
              <p>In build mode, left-click a trap you already own to take it to the next tier —
                 which also repairs it. Right-click sells it back for 70% of everything you spent.</p></section>
            <section><h3>Combo pays</h3>
              <p>Chained kills raise the multiplier to 5×, and score buys skulls, and skulls buy
                 enchantments in the spellbook. A leak resets it to nothing.</p></section>
            <section><h3>Three skulls, three ways to lose them</h3>
              <p>Your rating is the <em>worst</em> of rift, clock and score, so five skulls means a
                 flawless rift, a fast level and a high combo at once. The results screen names the
                 one that held you down.</p></section>
          </div>
          <div class="menu"><button class="btn primary" data-action="back">BACK</button></div>
        </div>
      </div>

      <div id="settings" class="overlay hidden"></div>
      <div id="spellbook" class="overlay hidden"></div>
      <div id="skills" class="overlay hidden"></div>
      <div id="armoury" class="overlay hidden"></div>
      <div id="results" class="overlay hidden"></div>

      <div id="pause" class="overlay hidden">
        <div class="sheet narrow">
          <div class="sheet-head"><h2 class="ornate">PAUSED</h2></div>
          <div class="menu column">
            <button class="btn primary" data-action="resume">RESUME</button>
            <button class="btn" data-action="skills">SKILLS</button>
            <button class="btn" data-action="spellbook">SPELLBOOK</button>
            <button class="btn" data-action="settings">SETTINGS</button>
            <button class="btn" data-action="restart">RESTART LEVEL</button>
            <button class="btn danger" data-action="quit">ABANDON</button>
          </div>
        </div>
      </div>
    `);

    this.el = {
      hud: q('#hud'), riftFill: q('#rift-fill'), riftValue: q('#rift-value'), riftPlaque: q('#rift-plaque'),
      waveLabel: q('#wave-label'), waveSub: q('#wave-sub'), wavePips: q('#wave-pips'),
      coin: q('#coin'), score: q('#score'), combo: q('#combo'), comboFeed: q('#combo-feed'),
      remaining: q('#remaining'), threat: q('#threat'), inspect: q('#inspect'),
      minimap: q('#minimap'), mmBody: q('#mm-body'), mmLanes: q('#mm-lanes'),
      hpFill: q('#hp-fill'), hpText: q('#hp-text'),
      manaFill: q('#mana-fill'), manaText: q('#mana-text'),
      weapons: q('#weapons'), spells: q('#spells'), weaponHint: q('#weapon-hint'),
      weaponName: q('#weapon-name'), trapbar: q('#trapbar'), cta: q('#phase-cta'),
      hints: q('#hint-strip'), tip: q('#trap-tip'), tutorial: q('#tutorial'),
      toasts: q('#toasts'), banner: q('#banner'),
      title: q('#title-screen'), levelSelect: q('#level-select'), howto: q('#howto'),
      settings: q('#settings'), spellbook: q('#spellbook'), skills: q('#skills'),
      armoury: q('#armoury'),
      results: q('#results'), pause: q('#pause'), levelGrid: q('#level-grid'),
    };
    this._current = 'title';
  }

  // ------------------------------------------------------------------- wiring
  _wire() {
    const g = this.game;

    this.root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-action]');
      if (!b || b.disabled) return;
      g.audio.play('ui.click');
      this._act(b.dataset.action, b);
    });

    this.root.addEventListener('mouseover', (e) => {
      if (e.target.closest('.btn, .trap-slot, .level-card, .sb-card')) g.audio.play('ui.hover');
    });

    // Trap tooltips. One shared element, positioned and clamped so it never leaves the
    // viewport on a narrow window.
    this.el.trapbar.addEventListener('mouseover', (e) => {
      const slot = e.target.closest('.trap-slot');
      if (slot) this._showTip(slot);
    });
    this.el.trapbar.addEventListener('mouseout', (e) => {
      if (!e.relatedTarget || !this.el.trapbar.contains(e.relatedTarget)) this._hideTip();
    });
    this.el.trapbar.addEventListener('focusin', (e) => {
      const slot = e.target.closest('.trap-slot');
      if (slot) this._showTip(slot);
    });
    this.el.trapbar.addEventListener('focusout', () => this._hideTip());

    // Settings sliders live-update as they are dragged.
    this.root.addEventListener('input', (e) => {
      const el = e.target;
      if (el.tagName !== 'INPUT' || !el.dataset.key) return;
      const spec = SETTINGS.find((s) => s.key === el.dataset.key);
      const v = Number(el.value);
      writeSetting(g, el.dataset.key, v);
      const out = this.el.settings.querySelector(`[data-out="${el.dataset.key}"]`);
      if (out && spec) out.textContent = pct(v, spec);
    });
    this.root.addEventListener('change', (e) => {
      if (e.target.dataset?.key) g.audio.play('ui.hover');
    });

    // --- game events -------------------------------------------------------
    g.bus.on('rift:damaged', ({ remaining, max }) => this._setRift(remaining, max));
    g.bus.on('coin:changed', ({ coin, delta }) => this._setCoin(coin, delta));
    g.bus.on('score:changed', ({ score }) => { this.el.score.textContent = score.toLocaleString(); });
    g.bus.on('combo:changed', ({ combo, multiplier }) => this._setCombo(combo, multiplier));
    g.bus.on('level:load', (p) => this._onLevelLoad(p));
    g.bus.on('wave:start', (p) => this._onWaveStart(p));
    g.bus.on('wave:clear', () => this._renderPips());
    g.bus.on('phase:build', (p) => this._onBuild(p));
    g.bus.on('game:victory', (p) => this.showResults({ ...p, win: true }));
    g.bus.on('game:defeat', (p) => this.showResults({ ...p, win: false }));
    g.bus.on('build:select', () => this._refreshTrapbar());
    g.bus.on('build:mode', ({ on }) => {
      this._refreshTrapbar();
      this._renderHints();
      if (!on) this._hideInspect();
    });

    // Caps are the whole point of a capped resource: "12 barricades" that you cannot see
    // the count of is just "some barricades". Every event that can move a count refreshes
    // the bar, and all four are rare.
    for (const ev of ['trap:placed', 'trap:sold', 'trap:destroyed']) {
      g.bus.on(ev, () => { this._refreshTrapbar(); this._renderHints(); });
    }
    g.bus.on('trap:damaged', (p) => this._onTrapDamaged(p));
    g.bus.on('trap:combo', (p) => this._onCombo(p));

    // The hero's own kit. Weapons and spells rebuild only on the events that change the
    // *set*; the per-frame sync in update() touches classes and one text node.
    g.bus.on('player:weapon', () => this._onWeapon());
    g.bus.on('player:progression', () => { if (this._current === 'skills') this._renderSkills(); });

    addEventListener('keydown', (e) => this._onKey(e));
    addEventListener('resize', () => { this._hideTip(); this._fitTrapbar(); });
  }

  _act(a, b) {
    const g = this.game;
    switch (a) {
      case 'play': {
        const start = Math.min(g.save.unlockedLevel ?? 0, LEVELS.length - 1);
        this.hideAll(); g.loadLevel(start); this.showHUD(); break;
      }
      case 'levels': this.showLevelSelect(); break;
      case 'howto': this._open('howto'); break;
      case 'settings': this.showSettingsScreen(); break;
      case 'spellbook': this.showSpellbook(); break;
      case 'skills': this.showSkills(); break;
      case 'armoury': this.openShop(); break;
      case 'back': this._back(); break;
      case 'resume': g.resume(); this.hideAll(); break;
      case 'restart': this.hideAll(); this.showHUD(); g.restartLevel(); break;
      case 'quit': this.showTitle(); g.state = 'menu'; break;
      case 'next': this.hideAll(); this.showHUD(); g.nextLevel(); break;
      case 'retry': this.hideAll(); this.showHUD(); g.restartLevel(); break;
      case 'level': this.hideAll(); this.showHUD(); g.loadLevel(Number(b.dataset.index)); break;
      case 'start-wave': g.director.startWave(); break;
      case 'pick-trap': this.closeShop(); g.traps.select(b.dataset.trap); break;
      case 'sb-upgrade':
        if (upgrade(g.save, b.dataset.trap)) { g.audio.play('ui.confirm'); this._renderSpellbook(); }
        else g.audio.play('ui.error');
        break;
      case 'sb-respec': respec(g.save); this._renderSpellbook(); break;
      case 'sk-buy': {
        const res = g.player?.progression?.buy(b.dataset.up);
        if (res?.ok) g.audio.play('ui.confirm'); else g.audio.play('ui.error');
        this._renderSkills();
        break;
      }
      case 'sk-respec': g.player?.progression?.respec(); this._renderSkills(); break;
      case 'set-toggle': {
        const key = b.dataset.key;
        const v = !readSetting(g, key);
        writeSetting(g, key, v);
        b.classList.toggle('on', v);
        b.setAttribute('aria-checked', String(v));
        break;
      }
      case 'wipe':
        if (b.dataset.armed) {
          g.save.reset();
          applyAllSettings(g);
          this._renderSettings();
          this.toast('Progress erased.', 'error');
        }
        else { b.dataset.armed = '1'; b.textContent = 'ERASE — ARE YOU SURE?'; b.classList.add('danger'); }
        break;
      case 'tut-skip': this.tutorial.skip(); break;
      default: break;
    }
  }

  _onKey(e) {
    const g = this.game;
    // Menus first: an open overlay owns the keyboard.
    if (this._current && this.nav.handleKey(e)) { e.preventDefault(); return; }

    if (e.code === 'Escape') {
      if (this._current === 'armoury') { this.closeShop(); return; }
      // Results has no "back" — the player has to choose what happens next.
      if (BACKABLE.includes(this._current)) { this._back(); return; }
      if (g.state === 'paused') { g.resume(); this.hideAll(); }
      else if (g.state === 'wave' || g.state === 'build') { g.pause(); this._open('pause', { stack: false }); }
      return;
    }
    if (this._current) return;   // gameplay hotkeys only when no overlay is up

    if (e.code === 'Tab' && (g.state === 'build' || g.state === 'wave')) g.traps.toggleBuild();
    // The map is the one HUD element big enough to be worth hiding, so it gets a key.
    if (e.code === 'KeyM' && (g.state === 'build' || g.state === 'wave')) {
      this.minimap.setEnabled(!this.minimap.enabled);
      this.el.minimap.classList.toggle('hidden', !this.minimap.enabled);
    }
    const n = /^Digit([1-9])$/.exec(e.code);
    if (n && (g.state === 'build' || g.state === 'wave')) {
      const id = g.traps.available[Number(n[1]) - 1];
      if (id) g.traps.select(id);
    }
  }

  // ---------------------------------------------------------------- lifecycle
  _open(key, { stack = true } = {}) {
    if (stack && this._current && this._current !== key) this._stack.push(this._current);
    for (const k of OVERLAYS) this.el[k].classList.toggle('hidden', k !== key);
    this._current = key;
    this._hideTip();
    // Focus the first control so a pad or the arrow keys have somewhere to start.
    this.nav.focusFirst();
  }

  _back() {
    const prev = this._stack.pop();
    if (prev) return this._open(prev, { stack: false });
    if (this.game.state === 'paused') return this._open('pause', { stack: false });
    // Closing the armoury mid-level must drop you back into the level, not the title.
    if (this.game.state === 'build' || this.game.state === 'wave') return this.hideAll();
    this._open('title', { stack: false });
  }

  hideAll() {
    for (const k of OVERLAYS) this.el[k].classList.add('hidden');
    this._stack.length = 0;
    this._current = null;
    this.nav.blur();
  }

  showTitle() {
    this.hideAll();
    this._open('title', { stack: false });
    this.el.hud.classList.add('hidden');
  }
  showHUD() { this.el.hud.classList.remove('hidden'); this._renderKit(); this._fitTrapbar(); }
  hideHUD() { this.el.hud.classList.add('hidden'); }

  showLevelSelect() {
    const save = this.game.save;
    const unlocked = save.unlockedLevel ?? 0;
    q('#ls-skulls').textContent = earnedSkulls(save);
    this.el.levelGrid.innerHTML = LEVELS.map((l, i) => {
      const locked = i > unlocked;
      const best = save.best(i);
      return `<button class="level-card ${locked ? 'locked' : ''}" ${locked ? 'disabled' : ''}
                data-action="level" data-index="${i}">
        <div class="lv-medal"><span>${i + 1}</span></div>
        <div class="lv-text">
          <div class="lv-name">${esc(l.name)}</div>
          <div class="lv-sub">${esc(l.subtitle)}</div>
        </div>
        <div class="lv-foot">
          ${locked ? `<span class="lv-lock">${LOCK}</span><span class="lv-locktext">LOCKED</span>`
                   : `<span class="lv-skulls">${skullRow(best?.skulls ?? 0)}</span>
                      <span class="lv-best">${best ? best.score.toLocaleString() : '—'}</span>`}
        </div>
      </button>`;
    }).join('');
    this._open('levelSelect');
  }

  showSettingsScreen() { this._renderSettings(); this._open('settings'); }
  _renderSettings() { this.el.settings.innerHTML = renderSettings(this.game); }

  showSpellbook() { this._renderSpellbook(); this._open('spellbook'); }
  _renderSpellbook() { this.el.spellbook.innerHTML = renderSpellbook(this.game); }

  showSkills() { this._renderSkills(); this._open('skills'); }
  _renderSkills() {
    this.el.skills.innerHTML = renderSkills(this.game);
    if (this._current === 'skills') this.nav.focusFirst();
  }

  showCampaignComplete() {
    this.showResults({ win: true, campaign: true, ...this.game.scoring.summary() });
  }

  // --- shop (ARCHITECTURE facade) -----------------------------------------
  /** The full armoury: every unlocked trap with what it costs and what it answers. */
  openShop() {
    const g = this.game;
    const ids = g.traps?.available ?? [];
    const cards = ids.map((id) => {
      const d = getTrapDef(id);
      if (!d) return '';
      const { good, bad } = trapAnswers(d);
      const afford = g.scoring.canAfford(d.cost);
      const tier = tierOf(g.save, id);
      return `<button class="shop-card ${afford ? '' : 'poor'}" data-action="pick-trap" data-trap="${id}"
                style="--acc:${trapAccent(d)}">
        <div class="shop-icon">${trapIcon(d)}</div>
        <div class="shop-main">
          <div class="shop-name">${esc(d.name)}${tier ? `<i class="tier-badge">+${tier}</i>` : ''}</div>
          <div class="shop-meta"><span class="ico sm">${surfaceIcon(d.surface)}</span>${esc(cap(d.surface))}
            · ${esc(trapCadence(d))}</div>
          <div class="shop-blurb">${esc(d.blurb ?? '')}</div>
          <div class="shop-tags">
            ${good.map((t) => `<span class="tag good">${esc(t)}</span>`).join('')}
            ${bad.map((t) => `<span class="tag bad">${esc(t)}</span>`).join('')}
          </div>
        </div>
        <div class="shop-cost ${afford ? '' : 'poor'}"><span class="ico">${COIN}</span>${d.cost}</div>
      </button>`;
    }).join('');

    this.el.armoury.innerHTML = `
      <div class="sheet wide">
        <div class="sheet-head">
          <h2 class="ornate">ARMOURY</h2>
          <div class="purse-line"><span class="ico">${COIN}</span>${g.scoring.coin.toLocaleString()} to spend</div>
        </div>
        <div class="shop-grid scroll-y">${cards || '<p class="empty">Nothing unlocked yet.</p>'}</div>
        <div class="menu"><button class="btn primary" data-action="back">CLOSE <kbd>ESC</kbd></button></div>
      </div>`;
    this._open('armoury');
  }
  closeShop() { if (this._current === 'armoury') this._back(); }

  // ------------------------------------------------------------------- events
  _onLevelLoad({ levelIndex }) {
    const g = this.game;
    // LevelDefs belongs to another module and is still growing; never assume a field.
    const def = LEVELS[g.levelIndex] ?? {};
    const rift = g.level?.rift;
    if (rift) this._setRift(rift.max, rift.max);
    this.el.score.textContent = '0';
    this.el.coin.textContent = g.scoring.coin.toLocaleString();
    this._refreshTrapbar();
    this._renderKit();
    this._renderPips();
    this._renderHints();
    this._hideInspect();
    this.el.comboFeed.innerHTML = '';
    if (def.name) this.banner(def.name, def.subtitle ?? '');
    if (def.brief) this.toast(def.brief, 'info', 6500);
    this.tutorial.maybeStart(levelIndex ?? g.levelIndex);
  }

  _onWaveStart({ waveIndex, waveCount, boss }) {
    this.el.waveLabel.textContent = `WAVE ${waveIndex + 1} / ${waveCount}`;
    this.el.waveSub.textContent = boss ? 'BOSS WAVE' : 'INCOMING';
    this.el.waveSub.classList.toggle('boss', !!boss);
    // Keep the threat list up during the fight, collapsed to icons: you still need to
    // remember that flyers are in this wave while you are shooting at the ground.
    this.el.threat.classList.toggle('mini', !this.el.threat.classList.contains('hidden'));
    this.el.cta.innerHTML = '';
    this._renderPips();
    this._renderHints();
    this._renderLanes(this.game.director?.preview(waveIndex));
    this._hideInspect();
    this.banner(boss ? 'BOSS WAVE' : `WAVE ${waveIndex + 1}`, boss ? 'Hold the line.' : '');
  }

  _onBuild({ nextWaveIndex }) {
    const g = this.game;
    this.el.waveLabel.textContent = `WAVE ${nextWaveIndex + 1} / ${g.director.waveCount}`;
    this.el.waveSub.textContent = 'BUILD PHASE';
    this.el.waveSub.classList.remove('boss');
    this.el.cta.innerHTML = `
      <button class="btn primary big" data-action="start-wave">START WAVE <kbd>ENTER</kbd></button>
      <button class="btn ghost" data-action="armoury">ARMOURY</button>`;
    this._renderThreat(g.director.preview(nextWaveIndex));
    this._renderPips();
    this._renderHints();
    this._refreshTrapbar();
  }

  setPhase(phase) { this.phase = phase; this.el.hud.dataset.phase = phase; }

  // ------------------------------------------------------------------ widgets
  _setRift(remaining, max) {
    const f = max ? remaining / max : 0;
    this.el.riftFill.style.width = `${Math.max(0, f) * 100}%`;
    this.el.riftFill.style.setProperty('--fill', f > 0.6 ? '#5cd4ff' : f > 0.3 ? '#ffb020' : '#ff3826');
    this.el.riftValue.textContent = remaining;
    this.el.riftPlaque.classList.toggle('critical', f <= 0.3);
  }

  _setCoin(coin, delta) {
    this.el.coin.textContent = coin.toLocaleString();
    if (delta) {
      const el = this.el.coin.parentElement;
      el.classList.remove('bump', 'drop');
      void el.offsetWidth;
      el.classList.add(delta > 0 ? 'bump' : 'drop');
    }
    this._refreshAffordable();
  }

  _setCombo(combo, mult) {
    const el = this.el.combo;
    if (combo < 3) { el.classList.remove('show'); return; }
    el.classList.add('show');
    el.innerHTML = `<span class="combo-x">${mult}×</span><span class="combo-n">${combo} KILLS</span>`;
    el.style.setProperty('--c', mult >= 4.5 ? '#ff4060' : mult >= 3 ? '#ff9a20' : mult >= 2 ? '#ffd050' : '#ffe9ac');
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
  }

  _renderPips() {
    const d = this.game.director;
    const n = d?.waveCount ?? 0;
    const cur = d?.waveIndex ?? -1;
    let s = '';
    for (let i = 0; i < n; i++) {
      const state = i < cur || (i === cur && !d.running) ? 'done' : i === cur ? 'now' : '';
      s += `<i class="pip ${state}"></i>`;
    }
    this.el.wavePips.innerHTML = s;
  }

  /** Contextual key legend — the phase decides which keys are worth naming. */
  _renderHints() {
    const g = this.game;
    const build = g.traps?.buildMode;
    const rows = g.state === 'wave'
      ? [['MMB drag', 'orbit / aim'], ['SPACE', 'dodge'], ['Q', 'weapon'], ['F C V', 'spells'], ['TAB', 'build']]
      // Left-click on an existing trap upgrades it — the single least discoverable
      // interaction in build mode, and the reason a trap has tiers at all.
      : build
        ? [['LMB', 'place / upgrade'], ['R', 'rotate'], ['RMB', 'sell 70%'], ['TAB', 'exit build']]
        : [['MMB drag', 'orbit / aim'], ['TAB', 'build'], ['1–9', 'pick trap'], ['M', 'map'], ['ENTER', 'start wave']];
    this.el.hints.innerHTML = rows
      .map(([k, v]) => `<span class="hint"><kbd>${k}</kbd>${v}</span>`).join('');
  }

  /**
   * The build-phase threat panel: **doors first**, abilities second, roster third.
   *
   * Doors lead because DIRECTOR's own measurement says gates, not orc count, are the
   * difficulty axis — a defence is priced per corridor and the coin economy scales on
   * `lanes^0.8`. A wave that opens two of six doors is a completely different build than
   * one that opens all six, and until this round the player could not tell the two apart
   * until the orcs were already walking. DIRECTOR's bot lost level 10 three times over
   * for exactly this reason.
   */
  _renderThreat(preview) {
    const el = this.el.threat;
    if (!preview) { el.classList.add('hidden'); this._renderLanes(null); return; }
    const t = readThreat(preview);
    this._renderLanes(preview);

    const total = this.game.grid?.spawns?.length ?? preview.laneCount ?? 0;
    const live = preview.laneCount ?? preview.gates?.length ?? 0;
    const lanePips = total
      ? Array.from({ length: total }, (_, i) => `<i class="lane-pip ${i < live ? 'on' : ''}"></i>`).join('')
      : '';
    const lanes = total ? `
      <div class="th-lanes ${live > 1 ? 'many' : ''}">
        <span class="th-gate">${GATE}</span>
        <span class="th-lane-txt"><b>${live}</b> of ${total} door${total === 1 ? '' : 's'} open</span>
        <span class="lane-pips">${lanePips}</span>
      </div>
      <div class="th-lane-note">${live > 1
        ? 'Every open corridor needs its own row. Watch the map.'
        : 'One corridor. Stack it.'}</div>` : '';

    const flags = t.threats.map((f) => `
      <div class="th-flag sev-${f.severity}">
        <span class="th-ico">${threatIcon(f.flag)}</span>
        <span class="th-txt">
          <b>${esc(f.label)}</b>
          <i>${esc(f.counter)}</i>
        </span>
      </div>`).join('');

    const roster = t.entries.map((e) => `
      <div class="th-row">
        <span class="th-n">${e.count}<i>×</i></span>
        <span class="th-name">${esc(e.def?.name ?? 'Unknown')}</span>
        <span class="th-tier" title="tier ${e.def?.tier ?? 1}">${'▮'.repeat(Math.min(6, e.def?.tier ?? 1))}</span>
      </div>`).join('');

    el.innerHTML = `
      <div class="th-head ${t.boss ? 'boss' : ''}">
        <span class="th-title">${t.boss ? 'BOSS WAVE' : 'INCOMING'}</span>
        <span class="th-count">${t.count} ORCS</span>
      </div>
      ${lanes}
      ${flags ? `<div class="th-flags">${flags}</div>` : '<div class="th-none">No special abilities. Straight fight.</div>'}
      <div class="th-roster">${roster}</div>`;
    el.classList.remove('hidden', 'mini');
  }

  /** The same fact, restated on the map header where the doors actually are. */
  _renderLanes(preview) {
    const el = this.el.mmLanes;
    if (!el) return;
    const total = this.game.grid?.spawns?.length ?? 0;
    const live = preview?.laneCount ?? preview?.gates?.length ?? 0;
    el.innerHTML = total
      ? `<b>${live}</b><i>/${total}</i> lanes`
      : '';
    el.classList.toggle('many', live > 2);
    this.minimap?.markRoutes();
  }

  /**
   * How many of this trap are placed, and the ceiling. A capped resource whose cap is
   * invisible is a bad resource: the Barricade allows twelve, the guardians six, and
   * before this round the only way to discover either was to be refused a placement.
   */
  _capOf(def) {
    if (def?.cap) return def.cap;
    if (def?.surface === 'guardian') return 6;   // TrapManager.canPlace's hard limit
    return 0;
  }
  _placedCount(id) {
    let n = 0;
    for (const t of this.game.traps?.list ?? []) if (!t.destroyed && t.def.id === id) n++;
    return n;
  }

  _refreshTrapbar() {
    const g = this.game;
    const avail = g.traps?.available ?? [];
    this.el.trapbar.innerHTML = avail.map((id, i) => {
      const d = getTrapDef(id);
      if (!d) return '';
      const sel = g.traps.selectedId === id && g.traps.buildMode;
      const afford = g.scoring.canAfford(d.cost);
      const tier = tierOf(g.save, id);
      const cap = this._capOf(d);
      const used = cap ? this._placedCount(id) : 0;
      return `<button class="trap-slot ${sel ? 'selected' : ''} ${afford ? '' : 'poor'} ${cap && used >= cap ? 'capped' : ''}"
                data-trap="${id}" style="--acc:${trapAccent(d)}" aria-label="${esc(d.name)}">
        <span class="ts-key">${i + 1}</span>
        <span class="ts-surface" aria-hidden="true">${surfaceIcon(d.surface)}</span>
        <span class="ts-icon">${trapIcon(d)}</span>
        ${tier ? `<i class="tier-badge">+${tier}</i>` : ''}
        ${cap ? `<i class="cap-badge ${used >= cap ? 'full' : ''}">${used}<span>/${cap}</span></i>` : ''}
        <span class="ts-name">${esc(d.name)}</span>
        <span class="ts-foot">
          <span class="ts-cost">${d.cost}</span>
          <span class="ts-cd">${esc(trapCadence(d))}</span>
        </span>
      </button>`;
    }).join('');
    for (const b of this.el.trapbar.querySelectorAll('.trap-slot')) {
      b.addEventListener('click', () => g.traps.select(b.dataset.trap));
    }
    this._fitTrapbar();
  }

  /**
   * Size the hotbar to the row instead of wrapping or scrolling it. Level 1 has two
   * traps and gets big labelled slots; level 10 has sixteen and gets a tight icon row.
   * A wrapping hotbar would climb into the play area, which is the one thing the HUD
   * must never do.
   */
  _fitTrapbar() {
    const bar = this.el.trapbar;
    const n = bar.children.length;
    if (!n) return;
    const host = bar.parentElement;
    const avail = (host?.clientWidth || Math.round(innerWidth * 0.55)) - 8;
    const gap = 6;
    const w = Math.max(36, Math.min(88, Math.floor((avail - gap * (n - 1)) / n)));
    bar.style.setProperty('--slot', `${w}px`);
    bar.classList.toggle('compact', w < 66);   // drop the name
    bar.classList.toggle('micro', w < 50);     // drop the cost too; `.poor` still reads
  }

  _refreshAffordable() {
    const g = this.game;
    for (const b of this.el.trapbar.querySelectorAll('.trap-slot')) {
      const d = getTrapDef(b.dataset.trap);
      if (d) b.classList.toggle('poor', !g.scoring.canAfford(d.cost));
    }
  }

  // --- trap tooltip --------------------------------------------------------
  _showTip(slot) {
    const d = getTrapDef(slot.dataset.trap);
    if (!d) return;
    const { good, bad } = trapAnswers(d);
    const tip = this.el.tip;
    const tier = tierOf(this.game.save, d.id);
    const lim = this._capOf(d);
    const used = lim ? this._placedCount(d.id) : 0;
    const up = d.upgrade?.costs ?? null;
    tip.style.setProperty('--acc', trapAccent(d));
    tip.innerHTML = `
      <div class="tip-head">
        <span class="tip-icon">${trapIcon(d)}</span>
        <span>
          <b>${esc(d.name)}</b>
          <i>${esc(cap(d.surface))} · ${esc(trapCadence(d))} · ◈${d.cost}${tier ? ` · +${tier} enchanted` : ''}</i>
        </span>
      </div>
      <p class="tip-blurb">${esc(d.blurb ?? '')}</p>
      ${lim ? `<div class="tip-cap ${used >= lim ? 'full' : ''}">
                 <b>${used} of ${lim}</b> placed${used >= lim ? ' — at the limit' : ''}</div>` : ''}
      ${up ? `<div class="tip-up">Upgrades to tier 3 — ◈${up.join(' then ◈')}</div>` : ''}
      ${good.length ? `<ul class="tip-list good">${good.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${bad.length ? `<ul class="tip-list bad">${bad.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}`;
    tip.classList.remove('hidden');

    // Clamp into the viewport: the bar is centred, so the end slots would otherwise
    // hang off the edge on a narrow window.
    const s = slot.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const pad = 10;
    const left = Math.max(pad, Math.min(innerWidth - t.width - pad, s.left + s.width / 2 - t.width / 2));
    const top = Math.max(pad, s.top - t.height - 12);
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    this._tipFor = slot.dataset.trap;
  }
  _hideTip() { this.el.tip.classList.add('hidden'); this._tipFor = null; }

  // --- placed-trap inspector ----------------------------------------------
  /**
   * Traps have hit points and three tiers now — they can be wrecked by an ogre and
   * repaired by upgrading — and none of that was visible. In build mode, whatever is
   * under the cursor gets a card: tier, health, what a left click costs and what a right
   * click pays back. The grid cell is the public way to ask "what is on this tile", so
   * this never reaches into TrapManager's internals.
   */
  _trapUnderCursor() {
    const g = this.game;
    if (!g.traps?.buildMode || !g.grid || !g.input?.aimWorld) return null;
    const { gx, gz } = g.grid.toCell(g.input.aimWorld, this._cellOut ??= { gx: 0, gz: 0 });
    const c = g.grid.cell(gx, gz);
    if (!c) return null;
    return c.blocker || c.floorTrap || c.ceilTrap
      || c.wallTraps?.N || c.wallTraps?.E || c.wallTraps?.S || c.wallTraps?.W || null;
  }

  _updateInspect() {
    const t = this._trapUnderCursor();
    const el = this.el.inspect;
    if (!t || t.destroyed) { this._hideInspect(); return; }

    const d = t.def;
    const hpF = t.hpMax ? Math.max(0, t.hp / t.hpMax) : 1;
    if (this._inspectFor !== t) {
      this._inspectFor = t;
      const upCost = d.upgrade?.costs?.[t.level - 1];
      el.style.setProperty('--acc', trapAccent(d));
      el.innerHTML = `
        <div class="ins-head">
          <span class="ins-icon">${trapIcon(d)}</span>
          <span class="ins-name">${esc(d.name)}</span>
          <span class="ins-pips">${'<i class="pip on"></i>'.repeat(t.level)}${'<i class="pip"></i>'.repeat(3 - t.level)}</span>
        </div>
        <div class="ins-hp"><div class="ins-hp-fill"></div><span class="ins-hp-txt"></span></div>
        <div class="ins-acts">
          <span class="ins-act ${upCost === undefined ? 'off' : ''}">
            <kbd>LMB</kbd>${upCost === undefined ? (t.level >= 3 ? 'tier 3' : 'no upgrade') : `upgrade ◈${upCost}`}</span>
          <span class="ins-act"><kbd>RMB</kbd>sell ◈${Math.round((t.spent ?? d.cost) * 0.7)}</span>
        </div>`;
      this._insFill = el.querySelector('.ins-hp-fill');
      this._insTxt = el.querySelector('.ins-hp-txt');
      el.classList.remove('hidden');
    }
    if (this._insFill) {
      this._insFill.style.width = `${hpF * 100}%`;
      this._insFill.style.setProperty('--fill', hpF > 0.55 ? '#6fd06a' : hpF > 0.25 ? '#ffb020' : '#ff3826');
      this._insTxt.textContent = `${Math.max(0, Math.ceil(t.hp))} / ${t.hpMax}`;
    }
  }

  _hideInspect() {
    this.el.inspect.classList.add('hidden');
    this._inspectFor = null;
    this._insFill = null;
  }

  /** A trap losing health is news even when it is off screen — that is the point. */
  _onTrapDamaged({ trap, remaining }) {
    if (trap === this._inspectFor) this._inspectFor = null;   // force a rebuild next frame
    const f = trap?.hpMax ? remaining / trap.hpMax : 1;
    if (f > 0.5 || this._dmgCd > this.game.clock.elapsed) return;
    this._dmgCd = this.game.clock.elapsed + 4;
    this.toast(`${trap.def.name} is being torn down`, 'error', 2000);
  }

  // --- trap combos ---------------------------------------------------------
  /**
   * Six trap interactions pay a bonus, and TRAPS teaches each one with a toast exactly
   * once. After that the only feedback was a ring in the world, which is invisible in a
   * fight. This is the persistent readout: a short stack under the combo counter, so
   * "the tar caught fire again" is a thing you can see happening on purpose.
   */
  _onCombo({ name, kind, bonus, multiplier }) {
    const label = String(name ?? kind ?? 'COMBO');
    const gain = bonus ?? multiplier ?? null;
    const el = document.createElement('div');
    el.className = 'cf-item';
    el.innerHTML = `<b>${esc(label)}</b>${gain ? `<i>+${Number(gain).toLocaleString()}</i>` : ''}`;
    this.el.comboFeed.appendChild(el);
    while (this.el.comboFeed.children.length > 3) this.el.comboFeed.firstChild.remove();
    setTimeout(() => el.remove(), 1600);
  }

  // --- the hero's kit ------------------------------------------------------
  _renderKit() {
    this.el.weapons.innerHTML = renderWeapons(this.game);
    this.el.spells.innerHTML = renderSpells(this.game);
    this._onWeapon();
  }

  /**
   * Two of the four weapons are semi-auto and holding the button does nothing. That was
   * called undiscoverable, and it is a labelling problem rather than a tuning one: the
   * chip says SEMI, the line under the strip says so in words the moment you equip it,
   * and holding the button on one lights the word instead of doing nothing at all.
   */
  _onWeapon() {
    const p = this.game.player;
    const w = p?.weapon;
    if (!w) return;
    const auto = w.def.auto !== false;
    this.el.weaponHint.textContent = auto ? '' : 'SEMI-AUTO — one click, one shot';
    this.el.weaponHint.classList.toggle('hidden', auto);
    this._holdFire = 0;
    syncWeapons(this.game, this.el.weapons);
  }

  // ------------------------------------------------------------- transient UI
  banner(title, sub = '') {
    const el = this.el.banner;
    el.innerHTML = `<div class="banner-title">${esc(title)}</div>${sub ? `<div class="banner-sub">${esc(sub)}</div>` : ''}`;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(this._bannerT);
    this._bannerT = setTimeout(() => el.classList.remove('show'), 2600);
  }

  toast(text, kind = 'info', ms = 2600) {
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.textContent = text;
    this.el.toasts.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, ms);
    while (this.el.toasts.children.length > 4) this.el.toasts.firstChild.remove();
  }

  // ------------------------------------------------------------------ results
  showResults(p) {
    const g = this.game;
    this.el.results.innerHTML = renderResults(g, p, {
      levelName: LEVELS[g.levelIndex]?.name ?? '',
      last: g.levelIndex >= LEVELS.length - 1,
    });
    this._stack.length = 0;
    this._open('results', { stack: false });
    if (!p.win) g.audio.play('defeat');
  }

  // -------------------------------------------------------------------- frame
  update(dt) {
    const g = this.game;
    const raw = g.clock?.rawDt ?? dt;

    // Menus can be driven by a pad on any screen, including the pause overlay.
    if (this._current) {
      const idx = g.input?.gamepadIndex;
      const pad = idx != null && navigator.getGamepads ? navigator.getGamepads()[idx] : null;
      this.nav.pollPad(pad, raw);
    }

    if (this.el.hud.classList.contains('hidden')) return;
    this.tutorial.update(dt);

    const p = g.player;
    if (p) {
      const f = Math.max(0, p.hp / p.hpMax);
      this.el.hpFill.style.width = `${f * 100}%`;
      this.el.hpFill.style.setProperty('--fill', f > 0.5 ? '#5fc96a' : f > 0.25 ? '#ffb020' : '#ff3826');
      this.el.hpText.textContent = Math.ceil(p.hp);
      if (p.manaMax) {
        const mf = Math.max(0, p.mana / p.manaMax);
        this.el.manaFill.style.width = `${mf * 100}%`;
        this.el.manaText.textContent = `${Math.floor(p.mana)}`;
        // The dry state has to be a *state*, not an absence: a weapon that costs more
        // mana than you hold is the reason your clicks are doing nothing.
        const cost = p.weapon?.def?.mana ?? 0;
        this.el.manaFill.parentElement.classList.toggle('dry', cost > 0 && p.mana < cost);
      }
      const w = p.weapon;
      if (w) {
        this.el.weaponName.textContent = w.def.name +
          (w.reloading > 0 ? ' — RELOADING' : (w.ammo !== Infinity ? `  ${w.ammo}/${w.def.magazine}` : ''));
        // Holding the button on a semi-auto weapon: light the label rather than swallow
        // the input silently.
        if (w.def.auto === false && !g.traps?.buildMode && g.input?.mouseDown?.(0)) {
          this._holdFire += raw;
          if (this._holdFire > 0.3) this.el.weaponHint.classList.add('nag');
        } else { this._holdFire = 0; this.el.weaponHint.classList.remove('nag'); }
      }
      syncWeapons(g, this.el.weapons);
      syncSpells(g, this.el.spells);
    }

    if (g.traps?.buildMode) this._updateInspect(); else if (this._inspectFor) this._hideInspect();
    this.minimap.update(raw);

    if (g.director?.running) {
      const n = g.director.remaining;
      this.el.remaining.innerHTML = `<span class="rem-n">${n}</span><span class="rem-l">ORCS LEFT</span>`;
      this.el.remaining.classList.remove('hidden');
    } else this.el.remaining.classList.add('hidden');
  }
}

// ------------------------------------------------------------------- helpers
const q = (s) => document.querySelector(s);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

/** The title crest: a rift eye set in an orcish iron collar. Pure SVG, no assets. */
function crest() {
  return `<svg viewBox="0 0 120 120" class="crest" aria-hidden="true">
    <defs>
      <radialGradient id="riftg" cx="50%" cy="50%">
        <stop offset="0%" stop-color="#eafcff"/><stop offset="45%" stop-color="#5cd4ff"/>
        <stop offset="100%" stop-color="#0d3550" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="goldg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ffe9ac"/><stop offset="55%" stop-color="#d9a441"/>
        <stop offset="100%" stop-color="#6b4a12"/>
      </linearGradient>
    </defs>
    <circle cx="60" cy="60" r="34" fill="url(#riftg)"/>
    <path d="M60 30c9 12 13 20 13 30s-6 18-13 18-13-8-13-18 4-18 13-30z" fill="#0a1a24" opacity=".65"/>
    <g fill="none" stroke="url(#goldg)" stroke-width="3.4">
      <circle cx="60" cy="60" r="42"/>
      <path d="M60 8v12M60 100v12M8 60h12M100 60h12"/>
    </g>
    <g fill="url(#goldg)">
      <path d="M60 2l6 10h-12zM60 118l6-10h-12zM2 60l10-6v12zM118 60l-10-6v12z"/>
      <path d="M28 28l10 4-6 6zM92 28l-4 10-6-6zM28 92l4-10 6 6zM92 92l-10-4 6-6z"/>
    </g>
  </svg>`;
}
