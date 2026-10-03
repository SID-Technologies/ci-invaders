/**
 * Pixel art for the board, drawn into a `Raster`: two pixels per terminal cell,
 * stacked with half blocks. Everything here is pure: a frame is a function of
 * its inputs, so the board redraws it from the frame clock and tests pin it.
 */

/** Transparent: the terminal's own background shows through. */
export const NONE = 0x01000000

export type Pixels = { width: number; height: number; data: number[] }

export function blank(width: number, height: number): Pixels {
  return { width, height, data: new Array<number>(width * height).fill(NONE) }
}

export function set(p: Pixels, x: number, y: number, color: number): void {
  const xi = Math.round(x)
  const yi = Math.round(y)
  if (xi < 0 || yi < 0 || xi >= p.width || yi >= p.height) return
  p.data[yi * p.width + xi] = color
}

export function get(p: Pixels, x: number, y: number): number {
  return p.data[y * p.width + x] ?? NONE
}

/** Stamp a sprite (rows of palette letters, `.` transparent) with its top-left at x, y. */
export function stamp(p: Pixels, sprite: readonly string[], x: number, y: number, palette: Record<string, number>): void {
  sprite.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) {
      const color = palette[row[dx] ?? '.']
      if (color !== undefined) set(p, x + dx, y + dy, color)
    }
  })
}

const UPPER = 0x2580 // ▀
const LOWER = 0x2584 // ▄
const SPACE = 0x20

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    out += B64[(n >> 18) & 63]
    out += B64[(n >> 12) & 63]
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? B64[n & 63] : '='
  }
  return out
}

/**
 * Pixels to `Raster` cells: little-endian u32 triplets [codePoint, fg, bg] per
 * cell, base64. Each cell carries two pixel rows: ▀ with the top as foreground
 * and the bottom as background, ▄ when only the bottom shows, a space when
 * neither does, so transparent pixels keep the terminal's own background.
 */
export function toCells(p: Pixels): { columns: number; rows: number; cells: string } {
  const columns = p.width
  const rows = Math.ceil(p.height / 2)
  const words = new Uint32Array(columns * rows * 3)
  for (let row = 0; row < rows; row++) {
    for (let x = 0; x < columns; x++) {
      const top = get(p, x, row * 2)
      const bottom = row * 2 + 1 < p.height ? get(p, x, row * 2 + 1) : NONE
      const i = (row * columns + x) * 3
      if (top === NONE && bottom === NONE) words.set([SPACE, NONE, NONE], i)
      else if (top === NONE) words.set([LOWER, bottom, NONE], i)
      else words.set([UPPER, top, bottom], i)
    }
  }
  return { columns, rows, cells: base64(new Uint8Array(words.buffer)) }
}

// ── Randomness that repeats: the same seed draws the same picture ───────

export function random(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return ((s >>> 0) % 100_000) / 100_000
  }
}

// ── Confetti: a burst from the bottom that falls back under gravity ─────

const CONFETTI = [0xff5c7a, 0xffc93c, 0x4ade80, 0x38bdf8, 0xa78bfa, 0xfb923c, 0xf472b6]

/** Frames a burst lasts at 50ms a frame: 2.5s. */
export const CONFETTI_FRAMES = 50

export function confettiFrame(seed: number, frame: number, width: number, height: number): Pixels {
  const p = blank(width, height)
  if (frame < 0 || frame >= CONFETTI_FRAMES) return p
  const rand = random(seed)
  const count = Math.max(20, Math.round(width * 0.9))
  const gravity = 0.09
  for (let i = 0; i < count; i++) {
    const x0 = width * (0.15 + rand() * 0.7)
    const vx = (rand() - 0.5) * 1.6
    const vy = -(1.2 + rand() * 1.3)
    const delay = Math.floor(rand() * 6)
    const color = CONFETTI[Math.floor(rand() * CONFETTI.length)] ?? 0xffffff
    const t = frame - delay
    if (t < 0) continue
    const x = x0 + vx * t
    const y = height - 1 + vy * t + 0.5 * gravity * t * t
    // Twinkle: every few frames a piece shows its edge and vanishes for a frame.
    if ((t + i) % 7 === 0) continue
    set(p, x, y, color)
  }
  return p
}

// ── Space invaders: one invader per Actions job ───────────────────────────
//
// Running jobs march in formation while the ship below picks them off one at a
// time. A job that passes blows up; one that fails turns red, drops to the
// ground and takes the ship with it. Clear them all and the ship celebrates.
// Stars drift down behind it all, so the scene moves even when nothing else does.

/** The scene's width when the board doesn't say; it stretches to the board's width. */
export const INVADERS_WIDTH = 64
export const INVADERS_HEIGHT = 22
/** At most this many invaders; more jobs than that share the last one's fate. */
export const MAX_INVADERS = 12
/** Frames a hit invader takes to burst. */
export const HIT_FRAMES = 8
/** Frames a failed invader takes to fall to the ground. */
export const FALL_FRAMES = 20
/** Frames the ship takes to explode before only debris is left. */
export const BOOM_FRAMES = 14
/** Frames a failure plays for, from the job failing to the debris settling. */
export const LOSS_FRAMES = FALL_FRAMES + BOOM_FRAMES
/** Frames the fireworks go on for after the last job is cleared. */
export const VICTORY_FRAMES = 40

export type InvaderState = 'pending' | 'pass' | 'fail' | 'skip'

/** One job: its state, and the frame it finished on when that was seen (else long ago). */
export type Invader = { state: InvaderState; doneAt?: number }

const INVADER_PALETTE: Record<string, number> = {
  a: 0xfacc15, // running
  r: 0xf87171, // failed
  s: 0x22d3ee, // ship
  w: 0xf8fafc, // shots and sparks
  o: 0xfb923c, // fire
  y: 0xfde047, // fire core
  g: 0x4b5563, // ground
  v: 0x4ade80, // you win
  d: 0x57534e, // debris
  t: 0x64748b, // far stars
  T: 0xcbd5e1, // near stars
}

const INVADER = [
  ['.xxx.', 'x.x.x', 'xxxxx', '.x.x.'],
  ['.xxx.', 'x.x.x', 'xxxxx', 'x...x'],
]
const BURST = [
  ['.....', '..w..', '.w.w.', '..w..'],
  ['w...w', '.o.o.', '..y..', '.o.o.'],
  ['o...o', '.....', '.....', 'o...o'],
]
/** The ship: a cell and a half tall, a nose `▄` over `▄▀▀▀▄`. */
const SHIP = ['..s..', '.sss.', 's...s']
const COLUMNS = 6
const STEP_X = 7
const STEP_Y = 5
const TOP = 1
const GROUND_Y = INVADERS_HEIGHT - 1
/**
 * The ship's top row: odd, so its nose is the bottom half of one cell and its
 * body fills the next, with a clear row under it so it never shares a cell with the ground.
 */
const SHIP_Y = GROUND_Y - 4
/** Where a failed invader comes to rest: on the ground where the ship was. */
const LAND_Y = SHIP_Y - 1
/** Frames the ship spends on each target: half moving under it, half shooting. */
const TARGET_FRAMES = 24

function tinted(sprite: readonly string[], letter: string): string[] {
  return sprite.map(row => row.replace(/x/g, letter))
}

/** Where the formation's top-left sits: it walks edge to edge and back, a pixel every 2 frames. */
function formationX(count: number, frame: number, width: number): number {
  const formation = Math.min(count, COLUMNS) * STEP_X - (STEP_X - 5)
  const room = Math.max(0, width - formation - 2)
  if (room === 0) return 1
  const step = Math.floor(frame / 2) % (room * 2)
  return 1 + (step < room ? step : room * 2 - step)
}

/** Each invader's home: columns of six, two rows at most. */
export function invaderAt(index: number, count: number, frame: number, width = INVADERS_WIDTH): { x: number; y: number } {
  return { x: formationX(count, frame, width) + (index % COLUMNS) * STEP_X, y: TOP + Math.floor(index / COLUMNS) * STEP_Y }
}

// A 5-pixel-tall font, just the letters the end screens need.
const LETTERS: Record<string, readonly string[]> = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  E: ['###', '#..', '##.', '#..', '###'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
  N: ['#..#', '##.#', '#.##', '#..#', '#..#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  W: ['#...#', '#...#', '#.#.#', '##.##', '#...#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  ' ': ['..', '..', '..', '..', '..'],
}

/** Write `text` centred at row `y` in `letter`'s colour. */
function banner(p: Pixels, text: string, y: number, letter: string): void {
  const glyphs = [...text].map(ch => LETTERS[ch] ?? LETTERS[' ']!)
  const width = glyphs.reduce((sum, g) => sum + (g[0]?.length ?? 0) + 1, -1)
  let x = Math.round((p.width - width) / 2)
  for (const g of glyphs) {
    stamp(p, g.map(row => row.replace(/#/g, letter)), x, y, INVADER_PALETTE)
    x += (g[0]?.length ?? 0) + 1
  }
}

export function invadersFrame(args: { invaders: readonly Invader[]; frame: number; width?: number }): Pixels {
  const { frame } = args
  const W = Math.max(32, args.width ?? INVADERS_WIDTH)
  const p = blank(W, INVADERS_HEIGHT)
  const pal = INVADER_PALETTE

  // Two layers of stars falling at different speeds.
  const rand = random(41)
  for (let i = 0; i < Math.round(W / 3.5); i++) {
    const x = Math.floor(rand() * W)
    const y0 = rand() * INVADERS_HEIGHT
    const isNear = i % 3 === 0
    const y = Math.floor(y0 + frame * (isNear ? 0.25 : 0.1)) % (INVADERS_HEIGHT - 1)
    set(p, x, y, (isNear ? pal.T : pal.t) ?? 0)
  }
  for (let x = 0; x < W; x++) set(p, x, GROUND_Y, pal.g ?? 0)

  const invaders = args.invaders.slice(0, MAX_INVADERS)
  const count = invaders.length
  const legs = Math.floor(frame / 8) % 2
  const ago = (inv: Invader) => (inv.doneAt === undefined ? Infinity : frame - inv.doneAt)
  const homeOf = (i: number) => invaderAt(i, count, frame, W)

  // The first failure to land ends the game.
  const failed = invaders
    .map((inv, i) => ({ inv, i, since: ago(inv) - FALL_FRAMES }))
    .filter(({ inv }) => inv.state === 'fail')
    .sort((a, b) => b.since - a.since)[0]
  const isOver = failed !== undefined && failed.since >= BOOM_FRAMES

  if (isOver) {
    // Game over: the invaders that landed, what's left of the ship, and the verdict.
    const cx = homeOf(failed.i).x + 2
    invaders.forEach((inv, i) => {
      if (inv.state === 'fail') stamp(p, tinted(INVADER[0]!, 'r'), homeOf(i).x, LAND_Y, pal)
    })
    for (const dx of [-7, -5, 4, 6, 8]) set(p, cx + dx, GROUND_Y - 1, pal.d ?? 0)
    banner(p, 'GAME OVER', 2, 'r')
    return p
  }

  invaders.forEach((inv, i) => {
    const home = homeOf(i)
    if (inv.state === 'pending') stamp(p, tinted(INVADER[legs]!, 'a'), home.x, home.y, pal)
    else if (inv.state === 'fail') {
      const fell = Math.min(1, ago(inv) / FALL_FRAMES)
      stamp(p, tinted(INVADER[legs]!, 'r'), home.x, Math.round(home.y + fell * (LAND_Y - home.y)), pal)
    } else if (ago(inv) < HIT_FRAMES) {
      stamp(p, BURST[Math.min(BURST.length - 1, Math.floor((ago(inv) / HIT_FRAMES) * BURST.length))]!, home.x, home.y, pal)
    }
  })

  if (failed) {
    // It slides under the falling invader, which lands on it and blows it up.
    const cx = homeOf(failed.i).x + 2
    if (failed.since < 0) {
      stamp(p, SHIP, cx - 2, SHIP_Y, pal)
      return p
    }
    const sparks = random(97)
    for (let i = 0; i < 24; i++) {
      const angle = sparks() * Math.PI * 2
      const r = failed.since * (0.4 + sparks() * 0.8)
      set(p, cx + Math.cos(angle) * r * 1.6, SHIP_Y + 1 + Math.sin(angle) * r, [pal.o, pal.y, pal.s, pal.w][i % 4] ?? 0)
    }
    return p
  }

  const running = invaders.map((inv, i) => ({ inv, i })).filter(({ inv }) => inv.state === 'pending')
  if (running.length === 0) {
    // Cleared: once the last burst is over, the ship takes a bow under YOU WIN, with fireworks for a while.
    const lastHit = Math.min(...invaders.map(ago))
    if (lastHit < HIT_FRAMES) {
      stamp(p, SHIP, Math.round(W / 2) - 2, SHIP_Y, pal)
      return p
    }
    const sinceWin = lastHit - HIT_FRAMES
    const hop = sinceWin < VICTORY_FRAMES ? Math.floor(frame / 4) % 2 : 0
    stamp(p, SHIP, Math.round(W / 2) - 2, SHIP_Y - hop * 2, pal) // a whole cell, so the shape holds
    if (count > 0) banner(p, 'YOU WIN', 2, 'v')
    if (count > 0 && sinceWin < VICTORY_FRAMES) {
      const sparks = random(Math.floor(frame / 6) + 1)
      for (let i = 0; i < 8; i++) {
        const side = i % 2 === 0 ? W * 0.2 : W * 0.8
        set(p, side - 4 + sparks() * 8, 1 + sparks() * 8, [pal.y, pal.w, pal.o, pal.v][i % 4] ?? 0)
      }
    }
    return p
  }

  const turn = Math.floor(frame / TARGET_FRAMES)
  const within = frame % TARGET_FRAMES
  const centre = ({ i }: { i: number }) => homeOf(i).x + 2
  const target = running[turn % running.length]!
  const from = running[(turn + running.length - 1) % running.length]!
  const half = TARGET_FRAMES / 2
  const shipX = Math.round(within < half ? centre(from) + (centre(target) - centre(from)) * (within / half) : centre(target))
  stamp(p, SHIP, shipX - 2, SHIP_Y, pal)
  if (within >= half) {
    // A shot climbs to the target and flashes where it lands.
    const top = homeOf(target.i).y + 4
    const y = SHIP_Y - 1 - (within - half)
    if (y >= top) {
      set(p, shipX, y, pal.w ?? 0)
      set(p, shipX, y + 1, pal.w ?? 0)
    } else if (y >= top - 2) set(p, shipX, top - 1, pal.y ?? 0)
  }
  return p
}
