#!/usr/bin/env node
/**
 * Deterministic docs check. No network, no secrets, no LLM: it fails the build when
 * the documentation names something that is not in the repository.
 *
 *   node scripts/check-docs.mjs            # exit 1 and a list of problems, or exit 0
 *
 * Checks, over the docs listed in DOC_FILES:
 *  1. Relative Markdown links point at files or directories that exist.
 *  2. `npm run <name>` names a script in package.json.
 *  3. Backticked repo paths (lib/x.ts, docs/y.md, app/z/ ...) exist.
 *  4. docs/ARCHITECTURE.md mentions every top-level directory in the repo.
 *
 * The bot (docs-maintainer.yml) handles judgement: whether prose is right. This only
 * handles facts a machine can check, so a broken link or a renamed script fails a PR.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Markdown files the check reads. Paths are relative to ROOT. */
export const DOC_FILES = [
  'README.md',
  'AGENTS.md',
  'collector/README.md',
  'ops/hermes-relay/README.md',
  'docs/ARCHITECTURE.md',
]
/** Plus every file in docs/ (scanned below). */
const DOC_DIRS = ['docs']

/** Top-level directories that must appear in ARCHITECTURE.md. */
const ARCH_FILE = 'docs/ARCHITECTURE.md'

const PATH_ROOTS = [
  'app', 'components', 'lib', 'engine', 'runner', 'ops', 'db', 'docs', 'scripts',
  'tests', 'supabase', 'collector', '.github', 'middleware.ts',
]

/**
 * Pure core: takes the file contents and the repo facts it needs, returns problems.
 * `files` is [{ path, text }], `exists(path)` tells if a repo path exists,
 * `scripts` is the package.json script names, `topDirs` the top-level directories.
 */
export function findProblems({ files, exists, scripts, topDirs, archPath = ARCH_FILE }) {
  const problems = []
  const scriptSet = new Set(scripts)

  for (const { path, text } of files) {
    const dir = dirname(path)
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      const where = `${path}:${i + 1}`

      // 1. Relative Markdown links: [label](target). Skip URLs, mail, and pure anchors.
      for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1].split('#')[0]
        if (!target || /^(https?:|mailto:)/.test(target)) continue
        const repoPath = target.startsWith('/') ? target.slice(1) : join(dir, target)
        const normalised = repoPath.split('\\').join('/').replace(/^\.\//, '')
        if (!exists(normalised)) {
          problems.push(`${where}: link target does not exist: ${target}`)
        }
      }

      // 2. npm run <script>
      for (const m of line.matchAll(/npm run ([a-zA-Z][a-zA-Z0-9:._-]*)/g)) {
        const name = m[1].replace(/[.:]+$/, '')
        if (!scriptSet.has(name)) {
          problems.push(`${where}: npm script not in package.json: ${name}`)
        }
      }

      // 3. Backticked repo paths. Only tokens that start with a known root, so prose and
      // route names like `/api/ops` are not mistaken for files.
      for (const m of line.matchAll(/`([^`\s]+)`/g)) {
        const token = m[1].replace(/[),.;:]+$/, '')
        if (token.includes('*') || token.includes('<') || token.includes('{')) continue
        const root = token.split('/')[0]
        const looksLikePath = PATH_ROOTS.includes(root) || PATH_ROOTS.includes(token)
        if (!looksLikePath) continue
        if (!/\.[A-Za-z0-9]+$/.test(token) && !token.endsWith('/') && !PATH_ROOTS.includes(token)) continue
        const cleaned = token.replace(/\/$/, '')
        if (!exists(cleaned)) {
          problems.push(`${where}: backticked path does not exist: ${token}`)
        }
      }
    })
  }

  // 4. Every top-level directory is named in the architecture map.
  const arch = files.find((f) => f.path === archPath)
  if (!arch) {
    problems.push(`${archPath}: missing (the architecture map must exist)`)
  } else {
    for (const dir of topDirs) {
      if (!arch.text.includes(`\`${dir}/\``) && !arch.text.includes(`\`${dir}\``)) {
        problems.push(`${archPath}: top-level directory not mapped: ${dir}/`)
      }
    }
  }

  return problems
}

function readRepo(root = ROOT) {
  const exists = (p) => existsSync(join(root, p))
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const topDirs = readdirSync(root).filter((name) => {
    if (name === 'node_modules' || (name.startsWith('.') && name !== '.github')) return false
    return statSync(join(root, name)).isDirectory()
  }).sort()
  const docDirFiles = DOC_DIRS.flatMap((d) =>
    readdirSync(join(root, d)).filter((f) => f.endsWith('.md')).map((f) => join(d, f)),
  )
  const paths = [...new Set([...DOC_FILES, ...docDirFiles])].filter(exists)
  const files = paths.map((p) => ({ path: p, text: readFileSync(join(root, p), 'utf8') }))
  return { files, exists, scripts: Object.keys(pkg.scripts ?? {}), topDirs }
}

// Run only when executed directly, not when a test imports findProblems.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = findProblems(readRepo())
  if (problems.length) {
    console.error(`docs check: ${problems.length} problem(s)`)
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }
  console.log('docs check: ok')
}
