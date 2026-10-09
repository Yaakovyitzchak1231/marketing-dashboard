/**
 * Shabbos quiet hours for pushes to people (WhatsApp and the like): from before Friday
 * candle lighting (sunset - 20 min) to after Saturday nightfall (sunset + 60 min), in Baltimore.
 * Deliberately wide: the sun formula is good to a minute or two, and a ping that waits ten extra
 * minutes costs nothing.
 * Pure arithmetic (NOAA sunrise/sunset equations), no network, no dependency.
 * The dashboard itself keeps working; only pushes to a phone are held, then sent after.
 */
const BALTIMORE = { lat: 39.2904, lon: -76.6122 }
const TZ = 'America/New_York'
const RAD = Math.PI / 180

/** Sunset (UTC Date) for the given calendar date (y, m 1-12, d) at lat/lon; official zenith 90.833. */
export function sunsetUtc(y: number, m: number, d: number, lat = BALTIMORE.lat, lon = BALTIMORE.lon): Date {
  const N1 = Math.floor((275 * m) / 9)
  const N2 = Math.floor((m + 9) / 12)
  const N3 = 1 + Math.floor((y - 4 * Math.floor(y / 4) + 2) / 3)
  const N = N1 - N2 * N3 + d - 30
  const lngHour = lon / 15
  const t = N + (18 - lngHour) / 24
  const M = 0.9856 * t - 3.289
  let L = M + 1.916 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 282.634
  L = ((L % 360) + 360) % 360
  let RA = Math.atan(0.91764 * Math.tan(L * RAD)) / RAD
  RA = ((RA % 360) + 360) % 360
  RA = (RA + (Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90)) / 15
  const sinDec = 0.39782 * Math.sin(L * RAD)
  const cosDec = Math.cos(Math.asin(sinDec))
  const cosH = (Math.cos(90.833 * RAD) - sinDec * Math.sin(lat * RAD)) / (cosDec * Math.cos(lat * RAD))
  const H = Math.acos(Math.max(-1, Math.min(1, cosH))) / RAD / 15
  const T = H + RA - 0.06571 * t - 6.622
  const UT = (((T - lngHour) % 24) + 24) % 24
  const base = Date.UTC(y, m - 1, d)
  // UT can wrap past midnight UTC (evening in the Americas): sunset on local date d is after noon local.
  let ms = base + UT * 3600_000
  if (UT < 12) ms += 24 * 3600_000
  return new Date(ms)
}

function localParts(at: Date): { y: number; m: number; d: number; weekday: number } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' })
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]))
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), weekday: wd }
}

function addDays(y: number, m: number, d: number, n: number): [number, number, number] {
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]
}

/** If `at` falls inside Shabbos, when it ends; otherwise null. */
export function shabbosEndsAt(at: Date = new Date()): Date | null {
  const { y, m, d, weekday } = localParts(at)
  if (weekday === 5) {
    const start = new Date(sunsetUtc(y, m, d).getTime() - 20 * 60_000)
    if (at < start) return null
    const [sy, sm, sd] = addDays(y, m, d, 1)
    return new Date(sunsetUtc(sy, sm, sd).getTime() + 60 * 60_000)
  }
  if (weekday === 6) {
    const end = new Date(sunsetUtc(y, m, d).getTime() + 60 * 60_000)
    return at < end ? end : null
  }
  return null
}
