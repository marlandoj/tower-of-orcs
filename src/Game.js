import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { Audio } from './core/Audio.js';
import { Grid } from './world/Grid.js';
import { Level } from './world/Level.js';
import { LEVELS } from './world/LevelDefs.js';
import { Player } from './entities/player/Player.js';
import { EnemyManager } from './entities/enemies/EnemyManager.js';
import { TrapManager } from './traps/TrapManager.js';
import { WaveDirector } from './director/WaveDirector.js';
import { Scoring } from './director/Scoring.js';
import { FX } from './fx/index.js';
import { UI } from './ui/index.js';
import { Save } from './core/Save.js';
import { installDebug } from './core/Debug.js';

/**
 * The root context. Constructed once; levels are loaded and torn down inside it.
 * Every subsystem holds a reference to this and nothing else global.
 */
export class Game {
  constructor(canvas) {
    this.engine = new Engine(canvas);
    this.scene = this.engine.scene;
    this.camera = this.engine.camera;
    this.renderer = this.engine.renderer;
    this.rig = this.engine.rig;
    this.clock = this.engine.clock;
    this.input = this.engine.input;
    this.bus = this.engine.bus;
    this.rng = this.engine.rng;

    this.state = 'menu';
    this.levelIndex = 0;
    this.save = new Save();

    this.audio = new Audio(this);
    this.fx = new FX(this);
    this.scoring = new Scoring(this);
    this.enemies = new EnemyManager(this);
    this.traps = new TrapManager(this);
    this.player = new Player(this);
    this.director = new WaveDirector(this);
    this.ui = new UI(this);

    this.level = null;
    this.grid = null;

    // Update order matters: input-driven first, then simulation, then reactive systems.
    this.engine.addSystem({ order: 10, update: (dt) => this.player.update(dt) });
    this.engine.addSystem({ order: 20, update: (dt) => this.enemies.update(dt) });
    this.engine.addSystem({ order: 30, update: (dt) => this.traps.update(dt) });
    this.engine.addSystem({ order: 40, update: (dt) => this.director.update(dt) });
    this.engine.addSystem({ order: 50, update: (dt) => this.fx.update(dt) });
    this.engine.addSystem({ order: 60, update: (dt) => this.level?.update(dt) });
    this.engine.addSystem({ order: 90, update: (dt) => this.ui.update(dt) });

    this.bus.on('game:defeat', () => { this.state = 'defeat'; });
    this.bus.on('game:victory', () => { this.state = 'victory'; });

    installDebug(this);
  }

  start() {
    this.engine.start(this);
    this.ui.showTitle();
  }

  /** Tear down the current level and build `index`. Safe to call at any time. */
  loadLevel(index) {
    const def = LEVELS[index];
    if (!def) { console.warn('no level', index); return; }
    this.levelIndex = index;

    this.enemies.clear();
    this.traps.clear();
    this.fx.clear();
    this.level?.dispose();

    this.grid = new Grid(def.width, def.height);
    this.level = new Level(this, def);
    this.level.build();

    this.scoring.reset(def);
    this.director.load(def);
    this.player.spawnAt(this.level.playerSpawn);
    this.rig.setBounds(this.level.cameraBounds);
    this.rig.setZoom(def.camera?.distance ?? 34);
    this.rig.yaw = def.camera?.yaw ?? 0;

    this.state = 'build';
    this.bus.emit('level:load', { levelIndex: index, level: this.level });
    this.rig.follow(this.player.position, null, this.player.viewHeading);
    this.rig.snap();
    this.ui.setPhase('build');
    this.bus.emit('phase:build', { nextWaveIndex: 0 });
  }

  restartLevel() { this.loadLevel(this.levelIndex); }
  nextLevel() {
    if (this.levelIndex + 1 < LEVELS.length) this.loadLevel(this.levelIndex + 1);
    else this.ui.showCampaignComplete();
  }

  pause() { if (this.state === 'wave' || this.state === 'build') { this._prev = this.state; this.state = 'paused'; } }
  resume() { if (this.state === 'paused') this.state = this._prev || 'build'; }
}
