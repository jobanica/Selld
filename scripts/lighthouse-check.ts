import { mkdirSync, writeFileSync } from 'node:fs'

import lighthouse from 'lighthouse'
import { chromium } from 'playwright'

/**
 * The phase 5 done-when, measured.
 *
 *   pnpm lighthouse
 *
 * Runs real Lighthouse in mobile configuration against the production build. Not
 * a synthetic LCP measurement of our own: the target is stated as a Lighthouse
 * score, so anything else would be grading our own homework with a different
 * rubric.
 *
 * Lighthouse's mobile preset applies "Slow 4G" throttling (1.6 Mbps down,
 * 150ms RTT) with a 4× CPU slowdown. That RTT is the number the whole
 * server-rendering decision was made against, and it is a fair stand-in for the
 * 3G budget in the brief — the brief's "3G" means "a mid-range Android phone on
 * mobile data", which is what this models.
 *
 * Exits non-zero when a threshold is missed, so it can gate CI.
 */

const HOST = process.env.LH_HOST ?? 'rheas-finds.localhost'
const PORT = process.env.LH_PORT ?? '5174'
const OUT_DIR = process.env.LH_OUT ?? '.lighthouse'

interface Target {
  name: string
  path: string
}

const TARGETS: Target[] = [
  { name: 'home', path: '/' },
  { name: 'product', path: '/p/linen-blend-blouse' },
]

/**
 * Hard gate: the phase's stated done-when. Missing any of these fails the run.
 */
const THRESHOLDS = {
  performance: 90,
  accessibility: 90,
  seo: 90,
  /** Not in the brief, but a store that shifts under a thumb loses the tap. */
  cls: 0.1,
}

/**
 * The architecture budget, reported but not gated.
 *
 * LCP < 2.0s is the number the server-rendering decision was made against, and it
 * is met on the home page (~1.5s). The product page currently lands near 2.1s
 * because its LCP element is the full-size product photo, and the demo fixture
 * writes PNGs — a real upload pipeline emitting WebP at the same dimensions is
 * roughly half the bytes, which is the specific follow-up rather than a tuning
 * knob here.
 *
 * Reported as a warning rather than raised to 2500 and called passing: a
 * threshold quietly moved to match the measurement stops being a threshold.
 */
const LCP_BUDGET_MS = 2000

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true })

  // Lighthouse drives Chrome over CDP on a fixed debugging port. Playwright's
  // bundled Chromium is already here, so use it rather than expecting a
  // system Chrome that a CI image may not have.
  const port = 9222
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? undefined,
    args: [`--remote-debugging-port=${port}`],
  })

  const failures: string[] = []
  const warnings: string[] = []
  const summary: Record<string, unknown>[] = []

  try {
    for (const target of TARGETS) {
      const url = `http://${HOST}:${PORT}${target.path}`
      process.stdout.write(`\n→ ${url}\n`)

      const result = await lighthouse(
        url,
        {
          port,
          output: ['json', 'html'],
          logLevel: 'error',
          // `mobile` is the default form factor, stated explicitly because the
          // whole target is phrased as "Lighthouse mobile".
          formFactor: 'mobile',
          screenEmulation: {
            mobile: true,
            width: 390,
            height: 844,
            deviceScaleFactor: 2,
            disabled: false,
          },
          throttlingMethod: 'simulate',
          onlyCategories: ['performance', 'accessibility', 'seo', 'best-practices'],
        },
        undefined,
      )

      if (result === undefined) throw new Error(`Lighthouse returned nothing for ${url}`)
      const { lhr, report } = result

      const scores = {
        performance: Math.round((lhr.categories.performance?.score ?? 0) * 100),
        accessibility: Math.round((lhr.categories.accessibility?.score ?? 0) * 100),
        seo: Math.round((lhr.categories.seo?.score ?? 0) * 100),
        bestPractices: Math.round((lhr.categories['best-practices']?.score ?? 0) * 100),
      }
      const lcpMs = lhr.audits['largest-contentful-paint']?.numericValue ?? Number.NaN
      const cls = lhr.audits['cumulative-layout-shift']?.numericValue ?? Number.NaN
      const fcpMs = lhr.audits['first-contentful-paint']?.numericValue ?? Number.NaN
      const tbtMs = lhr.audits['total-blocking-time']?.numericValue ?? Number.NaN
      const si = lhr.audits['speed-index']?.numericValue ?? Number.NaN

      const row = {
        page: target.name,
        ...scores,
        LCP: `${(lcpMs / 1000).toFixed(2)}s`,
        FCP: `${(fcpMs / 1000).toFixed(2)}s`,
        TBT: `${Math.round(tbtMs)}ms`,
        SI: `${(si / 1000).toFixed(2)}s`,
        CLS: cls.toFixed(3),
      }
      summary.push(row)
      console.table([row])

      const html = Array.isArray(report) ? report[1] : report
      if (typeof html === 'string') {
        writeFileSync(`${OUT_DIR}/${target.name}.html`, html)
      }
      const json = Array.isArray(report) ? report[0] : undefined
      if (typeof json === 'string') writeFileSync(`${OUT_DIR}/${target.name}.json`, json)

      const check = (label: string, actual: number, min: number) => {
        if (actual < min) failures.push(`${target.name}: ${label} ${actual} < ${min}`)
      }
      check('performance', scores.performance, THRESHOLDS.performance)
      check('accessibility', scores.accessibility, THRESHOLDS.accessibility)
      check('seo', scores.seo, THRESHOLDS.seo)
      if (lcpMs > LCP_BUDGET_MS) {
        warnings.push(
          `${target.name}: LCP ${(lcpMs / 1000).toFixed(2)}s over the ` +
            `${LCP_BUDGET_MS / 1000}s architecture budget`,
        )
      }
      if (cls > THRESHOLDS.cls) {
        failures.push(`${target.name}: CLS ${cls.toFixed(3)} > ${THRESHOLDS.cls}`)
      }

      // The specific audits worth naming when something regresses — a bare score
      // does not tell you which decision stopped holding.
      const notable = [
        'render-blocking-resources',
        'unminified-javascript',
        'uses-text-compression',
        'server-response-time',
        'prioritize-lcp-image',
        'unused-javascript',
        'legacy-javascript',
      ]
      const problems = notable
        .map((id) => lhr.audits[id])
        .filter((audit) => audit !== undefined && audit.score !== null && audit.score < 0.9)
      if (problems.length > 0) {
        console.log('  opportunities:')
        for (const audit of problems) {
          console.log(`    · ${audit?.title}: ${audit?.displayValue ?? ''}`)
        }
      }
    }
  } finally {
    await browser.close()
  }

  writeFileSync(`${OUT_DIR}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`)

  if (warnings.length > 0) {
    console.warn(`\n! ${warnings.length} budget warning(s):`)
    for (const warning of warnings) console.warn(`  · ${warning}`)
  }

  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length} threshold(s) missed:`)
    for (const failure of failures) console.error(`  · ${failure}`)
    process.exit(1)
  }
  console.log(`\n✓ all gated thresholds met. Reports in ${OUT_DIR}/`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
