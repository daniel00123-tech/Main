/**
 * Records a walkthrough video of the BigChange Lightning prototype.
 * Output: ../../demo/bigchange-lightning-walkthrough.webm
 */
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const outDir = path.resolve(root, '../../demo')
const videoDir = path.join(outDir, '.playwright-videos')

async function wait(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function startPreview() {
  const proc = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', '4173'], {
    cwd: root,
    stdio: 'pipe',
    shell: true,
  })
  for (let i = 0; i < 40; i++) {
    await wait(500)
    try {
      const res = await fetch('http://127.0.0.1:4173')
      if (res.ok) return proc
    } catch {
      /* retry */
    }
  }
  proc.kill()
  throw new Error('Preview server did not start')
}

async function main() {
  await mkdir(outDir, { recursive: true })
  await mkdir(videoDir, { recursive: true })

  console.log('Building app…')
  await new Promise((resolve, reject) => {
    const build = spawn('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: true })
    build.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('build failed'))))
  })

  const preview = await startPreview()
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } },
  })
  const page = await context.newPage()

  try {
    await page.goto('http://127.0.0.1:4173', { waitUntil: 'networkidle' })
    await wait(1200)

    await page.getByTestId('nav-planner').click()
    await wait(1800)

    await page.getByTestId('nav-jobs').click()
    await wait(800)
    await page.getByTestId('job-row-JOB-28495').click()
    await wait(2000)

    await page.getByTestId('nav-map').click()
    await wait(2200)

    await page.getByTestId('nav-messages').click()
    await wait(800)
    await page.getByTestId('thread-m2').click()
    await wait(1800)

    await page.getByTestId('nav-justask').click()
    await wait(800)
    await page.getByRole('button', { name: /margin by technician/i }).click()
    await page.getByTestId('justask-reply').waitFor({ timeout: 5000 })
    await wait(2500)

    await page.getByTestId('nav-agents').click()
    await wait(1800)

    await page.getByTestId('nav-dashboard').click()
    await wait(1500)
  } finally {
    await context.close()
    await browser.close()
    preview.kill('SIGTERM')
  }

  const { readdir } = await import('node:fs/promises')
  const videos = (await readdir(videoDir)).filter((f) => f.endsWith('.webm'))
  if (!videos.length) throw new Error('No video file produced')
  const src = path.join(videoDir, videos[0])
  const dest = path.join(outDir, 'bigchange-lightning-walkthrough.webm')
  const { rename } = await import('node:fs/promises')
  await rename(src, dest)
  console.log('Saved demo video to', dest)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
