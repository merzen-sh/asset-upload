import puppeteer from 'puppeteer'

const cookie = process.env.CFX_FORUM_COOKIE
if (!cookie) {
  console.error("CFX_FORUM_COOKIE not set")
  process.exit(1)
}

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
try {
  const page = await browser.newPage()

  await page.goto("https://portal-api.cfx.re/v1/auth/discourse?return=", {
    waitUntil: "domcontentloaded",
    timeout: 30000
  })
  const ssoBody = await page.evaluate(() => JSON.parse(document.body.innerText))
  const redirectUrl = ssoBody.url

  await page.setCookie({
    name: "_t",
    value: cookie,
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

  if (page.url().includes("login")) throw new Error("Redirected to login - cookie is expired or invalid")
} finally {
  await browser.close()
}
