import { Game } from './Game.js';

const canvas = document.getElementById('game-canvas');
const game = new Game(canvas);
game.start();

// Handy for sub-agents and for the browser console during review.
window.__GAME__ = game;
