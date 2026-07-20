// @ts-nocheck
import puppeteer from 'puppeteer'
import axios from "axios"
import { createReadStream, createWriteStream, readdirSync, statSync } from 'fs'
import { basename, resolve } from 'path'
import FormData from 'form-data'

const ERRORS = {
  NO_COOKIE: "CFX_FORUM_COOKIE not set",
  NO_ASSET_NAME: "ASSET_NAME not set (e.g. trek-core)",
  NO_ZIP: "No .zip file found in dist/",
  LOGIN_FAILED: "Redirected to login - cookie is expired or invalid",
  ASSET_NOT_FOUND: (name: string) => `Failed to find asset id for "${name}".`,
  REUPLOAD_FAILED: (err: string) => `Re-upload failed: ${err}`,
  PACK_TIMEOUT: "Pack not generated after 60s",
}

const cfx_forum_cookie = process.env.CFX_FORUM_COOKIE
const assetName = process.env.ASSET_NAME
const zipName = process.env.ZIP_FILE

if(!cfx_forum_cookie){ console.error(ERRORS.NO_COOKIE); process.exit(1) }
if(!assetName){ console.error(ERRORS.NO_ASSET_NAME); process.exit(1) }

const distDir = resolve("dist")
const zips = readdirSync(distDir).filter(f => f.endsWith(".zip"))
const zipFile = zipName || zips[0]
if(!zipFile){ console.error(ERRORS.NO_ZIP); process.exit(1) }

const zipPath = resolve(distDir, zipFile)
const chunkSize = 2 * 1024 * 1024

function api(cookieStr: string) {
  const headers = { Cookie: cookieStr }
  return {
    get: <T = any>(url: string) => axios.get<T>(url, { headers }),
    post: <T = any>(url: string, data?: any) => axios.post<T>(url, data, { headers }),
    delete: <T = any>(url: string) => axios.delete<T>(url, { headers }),
  }
}

async function login(browser: any, page: any) {
  await page.goto("https://portal-api.cfx.re/v1/auth/discourse?return=", {
    waitUntil: "domcontentloaded",
    timeout: 30000
  })
  const ssoBody = await page.evaluate(() => JSON.parse(document.body.innerText))
  const redirectUrl = ssoBody.url

  await page.setCookie({
    name: "_t",
    value: cfx_forum_cookie,
    domain: "forum.cfx.re",
    httpOnly: true,
    secure: true
  })

  await page.goto(redirectUrl, { waitUntil: "domcontentloaded", timeout: 30000 })

  await page.waitForFunction(
    () => window.location.href.includes("portal.cfx.re") && !window.location.href.includes("/authenticate"),
    { timeout: 30000 }
  )

  await page.goto("https://portal.cfx.re/assets/created-assets", {
    waitUntil: "domcontentloaded",
    timeout: 30000
  })

  if (page.url().includes("login")) throw new Error(ERRORS.LOGIN_FAILED)

  const allCookies = await browser.cookies()
  return allCookies.map(c => `${c.name}=${c.value}`).join("; ")
}

const browser = await puppeteer.launch({ headless: true,args: ['--no-sandbox', '--disable-setuid-sandbox'] })
try {
  const page = await browser.newPage()
  const cookieStr = await login(browser, page)
  const cfx = api(cookieStr)

  const searchRes = await cfx.get<{ items: { id: number }[] }>(
    `https://portal-api.cfx.re/v1/me/assets?search=${assetName}&sort=asset.name&direction=asc`
  )

  if (searchRes.data.items.length === 0) throw new Error(ERRORS.ASSET_NOT_FOUND(assetName))

  const assetId = searchRes.data.items[0].id
  const stats = statSync(zipPath)
  const totalSize = stats.size
  const originalFileName = basename(zipPath)
  const chunkCount = Math.ceil(totalSize / chunkSize)
  const version = process.env.VERSION || zipFile.replace(/^.*?[-](\d[\w.]+\d)/, "$1").replace(/\.zip$/, "")

  console.log(`Uploading ${originalFileName} (${totalSize} bytes, ${chunkCount} chunks)`)

  const versionsRes = await cfx.get<{ versions: { id: number; version: string }[] }>(
    `https://portal-api.cfx.re/v1/assets/${assetId}`
  )
  const versions = versionsRes.data.versions || []
  const targetIdx = versions.findIndex(v => v.version === version)
  if (targetIdx !== -1) {
    console.log(`Deleting existing version ${versions[targetIdx].id} (${version})...`)
    await cfx.delete(`https://portal-api.cfx.re/v1/assets/${assetId}/versions/${versions[targetIdx].id}`)
    versions.splice(targetIdx, 1)
  }
  while (versions.length >= 5) {
    const oldest = versions.reduce((a, b) => a.id < b.id ? a : b)
    console.log(`Version limit 5 reached, deleting oldest ${oldest.id} (${oldest.version})...`)
    await cfx.delete(`https://portal-api.cfx.re/v1/assets/${assetId}/versions/${oldest.id}`)
    versions.splice(versions.indexOf(oldest), 1)
  }

  const reUploadRes = await cfx.post<{ version_id: number; errors: any }>(
    `https://portal-api.cfx.re/v1/assets/${assetId}/re-upload`,
    {
      chunk_count: chunkCount,
      chunk_size: chunkSize,
      name: originalFileName,
      original_file_name: originalFileName,
      total_size: totalSize,
      release_candidate: false,
      version,
      changelog: ""
    }
  )

  if (reUploadRes.data.errors !== null) throw new Error(ERRORS.REUPLOAD_FAILED(JSON.stringify(reUploadRes.data.errors)))

  const versionId = reUploadRes.data.version_id
  const stream = createReadStream(zipPath, { highWaterMark: chunkSize })
  let chunkIndex = 0

  for await (const chunk of stream) {
    const form = new FormData()
    form.append('chunk_id', chunkIndex)
    form.append('chunk', chunk, {
      filename: 'blob',
      contentType: 'application/octet-stream'
    })

    await axios.post(
      `https://portal-api.cfx.re/v1/assets/${assetId}/versions/${versionId}/upload-chunk`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          Cookie: cookieStr
        }
      }
    )

    console.log(`Uploaded chunk ${chunkIndex + 1}/${chunkCount}`)
    chunkIndex++
  }

  await cfx.post(`https://portal-api.cfx.re/v1/assets/${assetId}/versions/${versionId}/complete-upload`, {})
  console.log("Upload completed! Waiting for pack generation...")

  let packId: number | null = null
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000))
    const detailRes = await cfx.get<{ versions: { id: number; packs: { id: number }[] }[] }>(
      `https://portal-api.cfx.re/v1/assets/${assetId}`
    )
    const ver = detailRes.data.versions.find(v => v.id === versionId)
    if (ver && ver.packs && ver.packs.length > 0 && ver.packs[0].id) {
      packId = ver.packs[0].id
      break
    }
    if (i % 5 === 0) console.log("  waiting for pack...")
  }

  if (!packId) throw new Error(ERRORS.PACK_TIMEOUT)
  console.log("Pack ID:", packId)

  const dlRes = await cfx.get<{ url: string }>(
    `https://portal-api.cfx.re/v1/assets/${assetId}/versions/${versionId}/packs/${packId}/download`
  )

  const packUrl = dlRes.data.url
  const outPath = resolve(distDir, `${basename(zipFile, ".zip")}.pack.zip`)

  console.log("Downloading pack...")
  const dlStream = await axios.get(packUrl, { responseType: "stream" })
  const writer = createWriteStream(outPath)
  dlStream.data.pipe(writer)
  await new Promise((res, rej) => {
    writer.on("finish", res)
    writer.on("error", rej)
  })

  console.log("Pack saved to:", outPath)
} finally {
  await browser.close()
}
