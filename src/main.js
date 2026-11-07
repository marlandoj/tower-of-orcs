import { Game } from './Game.js';

const canvas = document.getElementById('game-canvas');
const game = new Game(canvas);
game.start();

// Handy for sub-agents, the dev harness and the browser console. Dev server only.
if (import.meta.env.DEV) window.__GAME__ = game;
