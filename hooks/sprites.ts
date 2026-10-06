// Pixel art for Raster elements: two pixel rows per terminal cell using half
// blocks. Frames are functions of their inputs (the invaders' Ship aside).

// Transparent: the terminal's background shows through.
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

// Rows of palette letters; anything not in the palette is transparent.
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

// Raster cells are base64 little-endian u32 triplets [codePoint, fg, bg].
// ▀ draws top as fg and bottom as bg; ▄ and space keep transparent pixels
// transparent.
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

// Seeded xorshift, so frames are repeatable.
export function random(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return ((s >>> 0) % 100_000) / 100_000
  }
}

// ── Confetti ─────────────────────────────────────────────────────────────

const CONFETTI = [0xff5c7a, 0xffc93c, 0x4ade80, 0x38bdf8, 0xa78bfa, 0xfb923c, 0xf472b6]

export const CONFETTI_FRAMES = 50 // 2.5s at 50ms a frame

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
    if ((t + i) % 7 === 0) continue
    set(p, x, y, color)
  }
  return p
}

// ── Space invaders: one invader per Actions job ───────────────────────────
//
// Passed jobs burst, a failed one falls on the ship (GAME OVER), and clearing
// them all wins. The ship and the formation's position persist between frames
// in a Ship; everything else is a function of the frame.

export const INVADERS_WIDTH = 64
export const INVADERS_HEIGHT = 22
export const MAX_INVADERS = 12
export const HIT_FRAMES = 8
export const FALL_FRAMES = 20
export const BOOM_FRAMES = 14
export const LOSS_FRAMES = FALL_FRAMES + BOOM_FRAMES
export const VICTORY_FRAMES = 40
export const ENTER_FRAMES = 16

export type InvaderState = 'pending' | 'pass' | 'fail' | 'skip'

// slot: fixed position in the formation. seenAt: frame it appeared (it flies
// in). doneAt: frame it finished; unset means long ago.
export type Invader = { state: InvaderState; slot?: number; seenAt?: number; doneAt?: number }

export type Ship = {
  x: number // NaN until first drawn
  fx: number // formation's left edge
  dir: 1 | -1
  at?: number // last frame simulated
  target?: number
  dwell: number
  cooldown: number
  seed: number
  shots: { x: number; y: number }[]
  hits: { slot: number; age: number }[]
}

export function newShip(): Ship {
  return { x: NaN, fx: NaN, dir: 1, dwell: 0, cooldown: 0, seed: 1, shots: [], hits: [] }
}

const PAL = {
  a: 0xfacc15, // running
  r: 0xf87171, // failed
  s: 0x22d3ee, // ship
  w: 0xf8fafc, // shots, hit flash
  o: 0xfb923c,
  y: 0xfde047,
  g: 0x4b5563, // ground
  v: 0x4ade80, // YOU WIN
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
const SHIP = ['..s..', '.sss.', 's...s'] // ▄ over ▄▀▀▀▄
const COLUMNS = 6
const STEP_X = 7
const STEP_Y = 5
const TOP = 1
const GROUND_Y = INVADERS_HEIGHT - 1
// Odd, so the nose fills the bottom half of a cell and the body the next cell,
// with a blank row between the ship and the ground.
const SHIP_Y = GROUND_Y - 4
const LAND_Y = SHIP_Y - 1
const SHOT_SPEED = 2
const FLASH_FRAMES = 3
// Reload takes RELOAD_FRAMES plus up to RELOAD_JITTER more, at random.
const RELOAD_FRAMES = 14
const RELOAD_JITTER = 14
const DWELL_FRAMES = 24
const MAX_CATCH_UP = 60

function tinted(sprite: readonly string[], letter: string): string[] {
  return sprite.map(row => row.replace(/x/g, letter))
}

function approach(from: number, to: number, step: number): number {
  return from + Math.sign(to - from) * Math.min(Math.abs(to - from), step)
}

function roomFor(count: number, width: number): number {
  return Math.max(0, width - (Math.min(count, COLUMNS) * STEP_X - (STEP_X - 5)) - 2)
}

// Edge to edge and back, a pixel every 2 frames.
function formationX(count: number, frame: number, width: number): number {
  const room = roomFor(count, width)
  if (room === 0) return 1
  const step = Math.floor(frame / 2) % (room * 2)
  return 1 + (step < room ? step : room * 2 - step)
}

export function invaderAt(index: number, count: number, frame: number, width = INVADERS_WIDTH): { x: number; y: number } {
  return { x: formationX(count, frame, width) + (index % COLUMNS) * STEP_X, y: TOP + Math.floor(index / COLUMNS) * STEP_Y }
}

type Place = { slot: number; seenAt?: number; isRunning: boolean }

/**
 * Jobs keep their slots. A new job takes the slot of one that disappeared while
 * running (a waiting job GitHub now lists, a matrix job expanding) without
 * flying in; otherwise it gets a fresh slot, or a finished job's, and flies in.
 */
export function placeInvaders(
  before: ReadonlyMap<string, Place>,
  jobs: readonly { key: string; state: InvaderState }[],
  frame: number,
): Map<string, Place> {
  const next = new Map<string, Place>()
  for (const job of jobs) {
    const was = before.get(job.key)
    if (was) next.set(job.key, { ...was, isRunning: job.state === 'pending' })
  }
  const freed = [...before.entries()]
    .filter(([key]) => !next.has(key))
    .map(([, place]) => place)
    .sort((a, b) => a.slot - b.slot)
  let end = Math.max(-1, ...[...before.values()].map(place => place.slot)) + 1
  for (const job of jobs) {
    if (next.has(job.key)) continue
    const reuse = freed.shift()
    next.set(job.key, {
      slot: reuse ? reuse.slot : end++,
      seenAt: reuse?.isRunning ? reuse.seenAt : frame,
      isRunning: job.state === 'pending',
    })
  }
  return next
}

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

function banner(p: Pixels, text: string, y: number, letter: string): void {
  const glyphs = [...text].map(ch => LETTERS[ch] ?? LETTERS[' ']!)
  const width = glyphs.reduce((sum, g) => sum + (g[0]?.length ?? 0) + 1, -1)
  let x = Math.round((p.width - width) / 2)
  for (const g of glyphs) {
    stamp(p, g.map(row => row.replace(/#/g, letter)), x, y, PAL)
    x += (g[0]?.length ?? 0) + 1
  }
}

export function invadersFrame(args: { invaders: readonly Invader[]; frame: number; width?: number; ship?: Ship }): Pixels {
  const { frame } = args
  const W = Math.max(32, args.width ?? INVADERS_WIDTH)
  const p = blank(W, INVADERS_HEIGHT)
  const ship = args.ship ?? newShip()

  const rand = random(41)
  for (let i = 0; i < Math.round(W / 3.5); i++) {
    const x = Math.floor(rand() * W)
    const y0 = rand() * INVADERS_HEIGHT
    const isNear = i % 3 === 0
    const y = Math.floor(y0 + frame * (isNear ? 0.25 : 0.1)) % (INVADERS_HEIGHT - 1)
    set(p, x, y, isNear ? PAL.T : PAL.t)
  }
  for (let x = 0; x < W; x++) set(p, x, GROUND_Y, PAL.g)

  const invaders = args.invaders.map((inv, i) => ({ ...inv, slot: inv.slot ?? i })).filter(inv => inv.slot < MAX_INVADERS)
  const count = Math.max(0, ...invaders.map(inv => inv.slot + 1))
  const legs = Math.floor(frame / 8) % 2
  const ago = (inv: Invader) => (inv.doneAt === undefined ? Infinity : frame - inv.doneAt)
  const room = roomFor(count, W)
  if (Number.isNaN(ship.fx)) {
    ship.fx = formationX(count, frame, W)
    ship.dir = Math.floor(frame / 2) % (Math.max(1, room) * 2) < room ? 1 : -1
  }
  // `ahead` frames from now, for leading a shot.
  const homeOf = (slot: number, ahead = 0) => ({
    x: Math.floor(Math.max(1, Math.min(1 + room, ship.fx + ship.dir * 0.5 * ahead))) + (slot % COLUMNS) * STEP_X,
    y: TOP + Math.floor(slot / COLUMNS) * STEP_Y,
  })
  const placeOf = (inv: Invader & { slot: number }) => {
    const home = homeOf(inv.slot)
    const since = inv.seenAt === undefined ? Infinity : frame - inv.seenAt
    if (since >= ENTER_FRAMES) return home
    const t = Math.max(0, since) / ENTER_FRAMES
    return { x: home.x, y: Math.round(home.y - (1 - t * (2 - t)) * (home.y + 6)) }
  }

  const failed = invaders
    .map(inv => ({ inv, since: ago(inv) - FALL_FRAMES }))
    .filter(({ inv }) => inv.state === 'fail')
    .sort((a, b) => b.since - a.since)[0]

  if (failed && failed.since >= BOOM_FRAMES) {
    const cx = homeOf(failed.inv.slot).x + 2
    for (const inv of invaders) if (inv.state === 'fail') stamp(p, tinted(INVADER[0]!, 'r'), homeOf(inv.slot).x, LAND_Y, PAL)
    for (const dx of [-7, -5, 4, 6, 8]) set(p, cx + dx, GROUND_Y - 1, PAL.d)
    banner(p, 'GAME OVER', 2, 'r')
    return p
  }

  const running = invaders.filter(inv => inv.state === 'pending')
  const isCleared = running.length === 0 && !failed
  const sinceWin = Math.min(...invaders.map(ago)) - HIT_FRAMES

  if (Number.isNaN(ship.x)) ship.x = W / 2
  if (ship.at === undefined || ship.at > frame || frame - ship.at > MAX_CATCH_UP) ship.at = frame - 1
  ship.x = Math.max(2, Math.min(W - 3, ship.x))
  for (let f = ship.at + 1; f <= frame; f++) {
    ship.fx += ship.dir * 0.5
    if (ship.fx >= 1 + room) [ship.fx, ship.dir] = [1 + room, -1]
    if (ship.fx <= 1) [ship.fx, ship.dir] = [1, 1]
    for (const shot of ship.shots) shot.y -= SHOT_SPEED
    for (const hit of ship.hits) hit.age++
    ship.hits = ship.hits.filter(hit => hit.age < FLASH_FRAMES)
    ship.cooldown = Math.max(0, ship.cooldown - 1)

    const targets = running.filter(inv => inv.seenAt === undefined || f - inv.seenAt >= ENTER_FRAMES)
    ship.shots = ship.shots.filter(shot => {
      const struck = targets.find(inv => {
        const at = homeOf(inv.slot)
        return shot.x >= at.x && shot.x <= at.x + 4 && shot.y <= at.y + 3 && shot.y >= at.y
      })
      if (struck) ship.hits = [...ship.hits.filter(hit => hit.slot !== struck.slot), { slot: struck.slot, age: 0 }]
      return !struck && shot.y > 0
    })

    if (failed) {
      // Get under the falling invader by the time it lands.
      const goal = homeOf(failed.inv.slot).x + 2
      const left = frame - f - failed.since
      if (left > 0) ship.x = approach(ship.x, goal, Math.max(2, Math.abs(goal - ship.x) / left))
      continue
    }
    if (isCleared) {
      ship.x = approach(ship.x, Math.round(W / 2), 2)
      continue
    }
    if (targets.length === 0) continue

    const aim = (inv: { slot: number }) => {
      const flight = Math.max(0, Math.round((SHIP_Y - 1 - (homeOf(inv.slot).y + 3)) / SHOT_SPEED))
      return homeOf(inv.slot, flight).x + 2
    }
    let target = targets.find(inv => inv.slot === ship.target)
    if (!target || ship.dwell >= DWELL_FRAMES) {
      const choices = targets.length > 1 ? targets.filter(inv => inv.slot !== ship.target) : targets
      target = choices[Math.floor(random(ship.seed++)() * choices.length)]!
      ship.target = target.slot
      ship.dwell = 0
    }
    const goal = aim(target)
    ship.x = approach(ship.x, goal, 1)
    if (Math.abs(goal - ship.x) < 1) ship.dwell++
    // Fire at whatever is overhead, not just the target.
    if (ship.cooldown === 0 && targets.some(inv => Math.abs(aim(inv) - ship.x) <= 1)) {
      ship.shots.push({ x: Math.round(ship.x), y: SHIP_Y - 1 })
      ship.cooldown = RELOAD_FRAMES + Math.floor(random(ship.seed++)() * (RELOAD_JITTER + 1))
    }
  }
  ship.at = frame

  for (const inv of invaders) {
    const at = placeOf(inv)
    if (inv.state === 'pending') {
      const isHit = ship.hits.some(hit => hit.slot === inv.slot)
      stamp(p, tinted(INVADER[legs]!, isHit ? 'w' : 'a'), at.x, at.y, PAL)
    } else if (inv.state === 'fail') {
      const fell = Math.min(1, ago(inv) / FALL_FRAMES)
      stamp(p, tinted(INVADER[legs]!, 'r'), at.x, Math.round(at.y + fell * (LAND_Y - at.y)), PAL)
    } else if (ago(inv) < HIT_FRAMES) {
      stamp(p, BURST[Math.min(BURST.length - 1, Math.floor((ago(inv) / HIT_FRAMES) * BURST.length))]!, at.x, at.y, PAL)
    }
  }

  const shipX = Math.round(ship.x) - 2
  if (failed) {
    if (failed.since < 0) {
      stamp(p, SHIP, shipX, SHIP_Y, PAL)
      return p
    }
    const boom = random(97)
    for (let i = 0; i < 24; i++) {
      const angle = boom() * Math.PI * 2
      const r = failed.since * (0.4 + boom() * 0.8)
      set(p, ship.x + Math.cos(angle) * r * 1.6, SHIP_Y + 1 + Math.sin(angle) * r, [PAL.o, PAL.y, PAL.s, PAL.w][i % 4]!)
    }
    return p
  }

  for (const shot of ship.shots) {
    set(p, shot.x, shot.y, PAL.w)
    set(p, shot.x, shot.y + 1, PAL.w)
  }

  if (isCleared) {
    const isHome = Math.abs(ship.x - Math.round(W / 2)) < 1
    const isCelebrating = count > 0 && sinceWin >= 0 && sinceWin < VICTORY_FRAMES
    // Hop a whole cell so the half-block shape stays intact.
    const hop = isHome && isCelebrating ? (Math.floor(frame / 4) % 2) * 2 : 0
    stamp(p, SHIP, shipX, SHIP_Y - hop, PAL)
    if (count > 0 && sinceWin >= 0) banner(p, 'YOU WIN', 2, 'v')
    if (isCelebrating) {
      const sparks = random(Math.floor(frame / 6) + 1)
      for (let i = 0; i < 8; i++) {
        const side = i % 2 === 0 ? W * 0.2 : W * 0.8
        set(p, side - 4 + sparks() * 8, 1 + sparks() * 8, [PAL.y, PAL.w, PAL.o, PAL.v][i % 4]!)
      }
    }
    return p
  }

  stamp(p, SHIP, shipX, SHIP_Y, PAL)
  return p
}
