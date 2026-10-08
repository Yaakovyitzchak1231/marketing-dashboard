/**
 * The engine's data files (engine/data/): the top-1000 US cities with
 * coordinates, a first-name list for owner-name validation, and the Maps pb
 * request template. Read from disk, so the engine runs from the repo or from
 * the compiled .engine-dist copy alike.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function repoRoot(): string {
  let d = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(d, 'package.json')) && existsSync(join(d, 'engine', 'data'))) return d
    d = dirname(d)
  }
  return process.cwd()
}

export function dataPath(name: string): string {
  return join(repoRoot(), 'engine', 'data', name)
}

let firstNames: Set<string> | null = null
export function loadFirstNames(): Set<string> {
  if (!firstNames) firstNames = new Set(readFileSync(dataPath('first_names.txt'), 'utf8').split(/\s+/).filter(Boolean).map((s) => s.toLowerCase()))
  return firstNames
}

export function loadPbTemplate(): string {
  return readFileSync(dataPath('pb_template.txt'), 'utf8')
}

export interface City {
  city: string
  state: string // 2-letter
  population: number
  lat: number
  lng: number
}

let cities: City[] | null = null
export function loadCities(stateAbbr: Record<string, string>): City[] {
  if (cities) return cities
  const lines = readFileSync(dataPath('us_cities_top1000.csv'), 'utf8').trim().split(/\r?\n/).slice(1)
  cities = lines
    .map((l) => {
      const [city, state, pop, lat, lon] = l.split(',')
      return { city, state: stateAbbr[state] ?? state, population: Number(pop), lat: Number(lat), lng: Number(lon) }
    })
    .filter((c) => c.city && Number.isFinite(c.lat))
    .sort((a, b) => b.population - a.population)
  return cities
}
