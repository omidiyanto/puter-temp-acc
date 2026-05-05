// create_temp_account_hidden.js
//
// Same flow as create_temp_account.js, but runs the browser INVISIBLE.
// We do NOT use Chromium's --headless flag because Cloudflare Turnstile
// detects headless signals (GPU, window.chrome runtime, timings) and
// escalates to a hard challenge that cannot be solved.
//
// How "hidden" works:
//
//   Windows/macOS: launch a real visible window, but position it far
//     off-screen (--window-position=-32000,-32000) so the user never sees
//     it. The renderer is fully active, GPU/WebGL/fingerprint look normal.
//
//   Linux headless server (no DISPLAY): auto-spawn Xvfb — a virtual
//     framebuffer X server — and point the browser at it. Chrome "thinks"
//     it has a real display, renders normally, so Turnstile cannot tell
//     it apart from a real user. Requires the `Xvfb` binary to be
//     installed (apt-get install -y xvfb / dnf install -y xorg-x11-server-Xvfb).
//
// Usage:
//   node create_temp_account_hidden.js                   # default: bundled chromium, hidden
//   node create_temp_account_hidden.js --channel=chrome  # use real Chrome (more reliable)
//   node create_temp_account_hidden.js --count=5         # create 5 accounts
//   node create_temp_account_hidden.js --show            # DEBUG: show window (for troubleshooting)
//   node create_temp_account_hidden.js --true-headless   # experimental; will almost always fail Turnstile
//
// For full CLI options see README.

const { chromium } = require('patchright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

// ----------------------- arg parsing -----------------------
const args = process.argv.slice(2);
function flag(name, def) {
    const hit = args.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return def;
    if (!hit.includes('=')) return true;
    return hit.split('=').slice(1).join('=');
}
const opts = {
    show:         flag('show', false) === true,
    trueHeadless: flag('true-headless', false) === true,
    count:        parseInt(flag('count', '1'), 10),
    output:       String(flag('output', 'accounts.json')),
    timeout:      parseInt(flag('timeout', '90000'), 10),
    channel:      String(flag('channel', '')) || undefined,
    keepProfile:  flag('keep-profile', false) === true,
    delayMs:      parseInt(flag('delay', '3000'), 10),
    proxy:        String(flag('proxy', '')) || undefined, // e.g. http://user:pass@host:port
};

/**
 * Parse a proxy URL into Playwright's proxy config.
 * Examples:
 *   http://1.2.3.4:8080
 *   http://user:pass@proxy.example.com:8080
 *   socks5://127.0.0.1:1080
 */
function parseProxy(raw) {
    if (!raw) return undefined;
    try {
        const u = new URL(raw);
        const cfg = { server: `${u.protocol}//${u.host}` };
        if (u.username) cfg.username = decodeURIComponent(u.username);
        if (u.password) cfg.password = decodeURIComponent(u.password);
        return cfg;
    } catch (e) {
        console.error(`Invalid --proxy URL: ${raw} (${e.message})`);
        process.exit(2);
    }
}
const proxyConfig = parseProxy(opts.proxy);

const SIGNUP_URL    = 'https://puter.com/signup';
const DASHBOARD_URL = 'https://puter.com/dashboard';

// Window size is always applied so the page gets a sane viewport.
const WINDOW_SIZE_ARG = '--window-size=1280,800';
// Off-screen position — only used when a real display is in use (Windows /
// macOS desktop, Linux with existing X). Under Xvfb the display itself is
// already invisible, and -32000,-32000 can confuse some window managers.
const OFFSCREEN_ARG   = '--window-position=-32000,-32000';

// ----------------------- helpers -----------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand  = (a, b) => a + Math.random() * (b - a);
function log(idx, ...rest) { console.log(`[${idx}]`, ...rest); }

/**
 * On a Linux machine without a DISPLAY (e.g. headless server) we can't run
 * Chrome in headed mode directly. Auto-spawn an Xvfb virtual framebuffer
 * on a free display and point the browser at it.
 *
 * Returns the spawned Xvfb child process (so caller can keep a ref) or
 * null if nothing needed to be done.
 */
let xvfbProc = null;
async function ensureDisplay() {
    if (xvfbProc) return xvfbProc;                       // already running
    if (process.platform !== 'linux') return null;
    if (process.env.DISPLAY) return null;                // user already has X

    const which = spawnSync('which', ['Xvfb']);
    if (which.status !== 0) {
        console.error('\n⚠ No X display and Xvfb is not installed.');
        console.error('Install it:');
        console.error('  Debian/Ubuntu : sudo apt-get install -y xvfb');
        console.error('  Fedora/RHEL   : sudo dnf install -y xorg-x11-server-Xvfb');
        console.error('  Arch          : sudo pacman -S xorg-server-xvfb');
        console.error('');
        console.error('Or run the script manually under xvfb-run:');
        console.error('  xvfb-run -a --server-args="-screen 0 1280x800x24" node ' +
                      path.basename(process.argv[1]) + '\n');
        throw new Error('Xvfb not available');
    }

    // Pick a high-numbered display to avoid colliding with an existing X.
    const display = ':' + (99 + Math.floor(Math.random() * 900));
    console.log(`[xvfb] starting Xvfb on ${display} (1280x800x24)...`);
    const proc = spawn(
        'Xvfb',
        [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp', '-ac'],
        { stdio: 'ignore', detached: false },
    );

    // Wait briefly; if it exits in that window, it failed.
    await new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            proc.removeAllListeners('exit');
            proc.removeAllListeners('error');
            resolve();
        }, 800);
        proc.once('error', (e) => { clearTimeout(t); reject(e); });
        proc.once('exit', (code) => {
            clearTimeout(t);
            reject(new Error(`Xvfb exited early with code ${code}`));
        });
    });

    process.env.DISPLAY = display;
    xvfbProc = proc;
    console.log(`[xvfb] ready, DISPLAY=${display}`);

    // Graceful cleanup so we don't leak Xvfb processes.
    const cleanup = () => {
        if (xvfbProc && !xvfbProc.killed) {
            try { xvfbProc.kill('SIGTERM'); } catch {}
        }
    };
    process.on('exit', cleanup);
    process.on('SIGINT',  () => { cleanup(); process.exit(130); });
    process.on('SIGTERM', () => { cleanup(); process.exit(143); });

    return proc;
}

/**
 * Try to solve an interactive Turnstile widget.
 *
 * Strategy (in order):
 *   1. Frame API click — page.frameLocator() on the Cloudflare iframe, then
 *      .locator('input[type="checkbox"]').click(). This fires a "real"
 *      element click event inside the iframe's context. Patchright's
 *      CDP-patches make this click look like a genuine user interaction,
 *      which is what Turnstile grades.
 *   2. Coordinate click — fallback for cases where the iframe has no
 *      checkbox input (older widget variants) or the selector times out.
 *
 * Returns: 'frame' | 'coord' | false
 */
async function tryClickTurnstile(page, idx) {
    // ---- 1. Frame-API click ----
    try {
        const frameLoc = page.frameLocator('iframe[src*="challenges.cloudflare.com"]').first();
        const checkbox = frameLoc.locator('input[type="checkbox"]').first();
        await checkbox.waitFor({ state: 'visible', timeout: 6000 });
        log(idx, 'Turnstile checkbox found via frame API; clicking...');
        await checkbox.click({ delay: Math.round(rand(50, 140)) });
        return 'frame';
    } catch (e) {
        log(idx, `frame-API click not available (${e.message.split('\n')[0]}); falling back to coords`);
    }

    // ---- 2. Coordinate click on iframe bounding box ----
    const iframeElems = await page.$$('iframe[src*="challenges.cloudflare.com"]');
    for (const el of iframeElems) {
        const box = await el.boundingBox().catch(() => null);
        if (!box) continue;
        if (box.width < 200 || box.height < 40) continue;

        const targetX = box.x + rand(26, 34);
        const targetY = box.y + box.height / 2 + rand(-3, 3);

        log(idx, `coord-click Turnstile (${Math.round(box.width)}x${Math.round(box.height)}) @ viewport (${Math.round(targetX)},${Math.round(targetY)})`);

        const startX = targetX - rand(80, 140);
        const startY = targetY + rand(-30, 30);
        await page.mouse.move(startX, startY);
        await sleep(rand(80, 180));
        await page.mouse.move(targetX - rand(20, 40), targetY + rand(-6, 6), { steps: 6 });
        await sleep(rand(60, 140));
        await page.mouse.move(targetX, targetY, { steps: 4 });
        await sleep(rand(60, 150));
        await page.mouse.down();
        await sleep(rand(40, 90));
        await page.mouse.up();
        return 'coord';
    }
    return false;
}

// ----------------------- main per-account -----------------------
async function createOne(idx) {
    // On Linux-without-DISPLAY we transparently bring up Xvfb. On macOS /
    // Windows this is a no-op.
    let usingXvfb = false;
    if (!opts.trueHeadless) {
        const spawned = await ensureDisplay();
        usingXvfb = spawned !== null;
    }

    const userDataDir = path.join(os.tmpdir(), `puter_pwh_${process.pid}_${idx}_${Date.now()}`);
    fs.mkdirSync(userDataDir, { recursive: true });

    const mode = opts.trueHeadless
        ? 'TRUE-HEADLESS (likely to fail)'
        : opts.show
            ? 'VISIBLE (debug)'
            : usingXvfb
                ? 'HIDDEN (Xvfb virtual display)'
                : 'HIDDEN (off-screen window)';
    log(idx, `launching ${opts.channel || 'bundled chromium'} [${mode}]`);

    // Assemble launch flags. On Linux root requires --no-sandbox; we add it
    // on all Linux since Playwright's chromium download only enables the
    // SUID chrome-sandbox when available.
    const extraArgs = [WINDOW_SIZE_ARG];
    if (!opts.show && !opts.trueHeadless && !usingXvfb) {
        extraArgs.push(OFFSCREEN_ARG);
    }
    if (process.platform === 'linux') extraArgs.push('--no-sandbox');

    const launchOpts = {
        headless: opts.trueHeadless ? true : false,
        viewport: null,
        args:     extraArgs,
    };
    if (opts.channel) launchOpts.channel = opts.channel;
    if (proxyConfig) {
        launchOpts.proxy = proxyConfig;
        log(idx, `using proxy ${proxyConfig.server}${proxyConfig.username ? ' (authenticated)' : ''}`);
    }

    const context = await chromium.launchPersistentContext(userDataDir, launchOpts);
    const page    = context.pages()[0] || await context.newPage();

    // If we're in hidden mode the window is off-screen — set viewport so the
    // page still renders at sane dimensions even though we passed viewport:null.
    // (Patchright docs prefer viewport:null, but with off-screen windows the
    // window size sometimes ends up tiny; this is a safety net.)
    if (!opts.show && !opts.trueHeadless) {
        await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
    }

    let signupRequest  = null;
    let signupResponse = null;
    let signupStatus   = null;

    context.on('request', req => {
        if (req.url() === SIGNUP_URL && req.method() === 'POST') {
            try {
                signupRequest = {
                    url:     req.url(),
                    headers: req.headers(),
                    body:    JSON.parse(req.postData() || '{}'),
                };
                const token = signupRequest.body['cf-turnstile-response'];
                log(idx, `POST /signup captured; cf-turnstile-response=${token ? token.slice(0, 24) + '...' : '(none)'}`);

                // Log the most signal-bearing fingerprint headers so user can
                // compare against their browser HAR to find any missing bit.
                const h = signupRequest.headers;
                const fp = {
                    'user-agent':         h['user-agent'],
                    'sec-ch-ua':          h['sec-ch-ua'],
                    'sec-ch-ua-platform': h['sec-ch-ua-platform'],
                    'sec-ch-ua-mobile':   h['sec-ch-ua-mobile'],
                    'accept-language':    h['accept-language'],
                    'origin':             h['origin'],
                    'referer':            h['referer'],
                    'x-requested-with':   h['x-requested-with'],
                };
                log(idx, 'fingerprint headers:\n' + JSON.stringify(fp, null, 2));
            } catch (e) {
                log(idx, 'failed to parse signup request body:', e.message);
            }
        }
    });
    context.on('response', async resp => {
        if (resp.url() === SIGNUP_URL && resp.request().method() === 'POST') {
            signupStatus = resp.status();
            try {
                signupResponse = await resp.json();
                log(idx, `POST /signup response status=${signupStatus} username=${signupResponse?.user?.username || '?'}`);
            } catch {
                const t = await resp.text().catch(() => '');
                log(idx, `/signup non-JSON status=${signupStatus} body=${t}`);
                signupResponse = { _raw: t };
            }
        }
    });

    log(idx, `navigating to ${DASHBOARD_URL}`);
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' }).catch(e => {
        log(idx, 'goto warning:', e.message);
    });

    // Retry click roughly every 8s if no response yet — the widget may
    // reset itself after a failed challenge, giving us another chance.
    const start = Date.now();
    let lastClickAt = 0;
    let clickCount  = 0;
    while (!signupResponse && Date.now() - start < opts.timeout) {
        if (Date.now() - lastClickAt > 8000) {
            try {
                const how = await tryClickTurnstile(page, idx);
                if (how) {
                    clickCount++;
                    lastClickAt = Date.now();
                    log(idx, `click attempt #${clickCount} via ${how}`);
                }
            } catch (e) {
                log(idx, 'click attempt threw:', e.message.split('\n')[0]);
            }
        }
        await sleep(500);
    }

    // If we failed, save a screenshot + HTML so the user can see what
    // Cloudflare actually showed us (puzzle, error, unchecked checkbox, …).
    if (!signupResponse) {
        try {
            const base = `debug_${idx}_${Date.now()}`;
            const shotPath = path.resolve(`${base}.png`);
            const htmlPath = path.resolve(`${base}.html`);
            await page.screenshot({ path: shotPath, fullPage: true });
            const html = await page.content().catch(() => '');
            if (html) fs.writeFileSync(htmlPath, html);
            log(idx, `TIMEOUT — debug artifacts saved:\n    ${shotPath}\n    ${htmlPath}`);
        } catch (e) {
            log(idx, 'failed to save debug artifacts:', e.message);
        }
    }

    const cookies = await context.cookies().catch(() => []);
    await context.close().catch(() => {});
    if (!opts.keepProfile) {
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    } else {
        log(idx, `profile kept at ${userDataDir}`);
    }

    if (!signupResponse) {
        log(idx, `TIMEOUT after ${opts.timeout}ms — no /signup response captured`);
        return null;
    }
    if (signupStatus !== 200 || !signupResponse.token) {
        log(idx, `FAILED: status=${signupStatus} body=${JSON.stringify(signupResponse).slice(0, 200)}`);
        return {
            timestamp:              new Date().toISOString(),
            failed:                 true,
            status:                 signupStatus,
            cf_turnstile_response:  signupRequest?.body?.['cf-turnstile-response'] || null,
            signup_request_body:    signupRequest?.body    || null,
            signup_request_headers: signupRequest?.headers || null,
            signup_response:        signupResponse,
        };
    }

    return {
        timestamp:              new Date().toISOString(),
        cf_turnstile_response:  signupRequest?.body?.['cf-turnstile-response'] || null,
        signup_request_body:    signupRequest?.body    || null,
        signup_request_headers: signupRequest?.headers || null,
        signup_response:        signupResponse,
        cookies,
    };
}

// ----------------------- driver -----------------------
(async () => {
    console.log('Puter temp-account creator [HIDDEN MODE] (patchright)');
    console.log(JSON.stringify(opts, null, 2));

    let existing = [];
    if (fs.existsSync(opts.output)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(opts.output, 'utf8'));
            if (Array.isArray(parsed)) existing = parsed;
        } catch { /* start fresh */ }
    }

    const fresh = [];
    for (let i = 1; i <= opts.count; i++) {
        try {
            const r = await createOne(i);
            if (r) fresh.push(r);
        } catch (e) {
            console.error(`[${i}] error:`, e);
        }
        if (i < opts.count) {
            console.log(`waiting ${opts.delayMs}ms before next account...`);
            await sleep(opts.delayMs);
        }
    }

    const all = existing.concat(fresh);
    fs.writeFileSync(opts.output, JSON.stringify(all, null, 2));

    const ok = fresh.filter(a => !a.failed);
    console.log(`\nSaved ${fresh.length} record(s) to ${opts.output} (file now has ${all.length} total, ${ok.length} successful this run).`);

    console.log('\n=== Summary (this run) ===');
    for (const a of fresh) {
        if (a.failed) {
            console.log(`FAILED status=${a.status} msg=${a.signup_response?.message || a.signup_response?.error || '?'}`);
            continue;
        }
        const u = a.signup_response?.user || {};
        const tok = a.signup_response?.token || '';
        const cft = a.cf_turnstile_response || '';
        console.log(
            `OK  username=${u.username}  uuid=${u.uuid}  is_temp=${u.is_temp}\n` +
            `    jwt:   ${tok.slice(0, 40)}...\n` +
            `    cf-t:  ${cft.slice(0, 40)}...`
        );
    }

    if (ok.length === 0) process.exit(1);
})().catch(e => {
    console.error('FATAL:', e);
    process.exit(1);
});
