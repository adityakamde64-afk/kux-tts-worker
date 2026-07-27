/**
 * KUX TTS GitHub Actions Worker
 * Firefox + Headless + Playwright
 * Supports: Kyutai TTS + Cartesia Sonic
 */
import { firefox } from 'playwright';
import fs from 'fs';
import path from 'path';

const ENGINE = process.env.TTS_ENGINE || 'kyutai';
const TEXT = process.env.TTS_TEXT || '';
const VOICE = process.env.TTS_VOICE || '';
const LANGUAGE = process.env.TTS_LANGUAGE || 'American English';
const OUTPUT_DIR = './output';

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function splitText(text, chunkSize = 500) {
  if (!text.trim()) return [];
  const lines = text.split(/\n+/).map(l => l.trim()).filter(l => l.length > 0);
  const fragments = [];
  for (const line of lines) {
    const parts = line.match(/[^.!?]+[.!?]+/g);
    if (parts && parts.length > 1) {
      fragments.push(...parts.map(p => p.trim()).filter(p => p));
    } else {
      const subParts = line.match(/[^,;:]+[,;:]?/g);
      if (subParts && subParts.length > 1) {
        fragments.push(...subParts.map(p => p.trim()).filter(p => p));
      } else {
        fragments.push(line);
      }
    }
  }
  const safePieces = [];
  for (const frag of fragments) {
    if (frag.length <= chunkSize) {
      safePieces.push(frag);
    } else {
      const words = frag.split(/\s+/);
      let buf = '';
      for (const w of words) {
        if (!w) continue;
        if (buf && (buf + ' ' + w).length > chunkSize) {
          safePieces.push(buf);
          buf = w;
        } else {
          buf = buf ? buf + ' ' + w : w;
        }
      }
      if (buf) safePieces.push(buf);
    }
  }
  const chunks = [];
  let current = '';
  for (const piece of safePieces) {
    const combined = current ? current + ' ' + piece : piece;
    if (combined.length > chunkSize && current) {
      chunks.push(current);
      current = piece;
    } else {
      current = combined;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/* KYUTAI TTS */
async function processKyutaiChunk(context, text, partId) {
  const page = await context.newPage();
  try {
    console.log(`[Part ${partId}] Opening Kyutai TTS...`);
    await page.goto('https://kyutai.org/tts', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);

    await page.evaluate(() => {
      const h2s = Array.from(document.querySelectorAll('h2'));
      const target = h2s.find(h => h.textContent && h.textContent.includes('1.6B'));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    await page.waitForTimeout(1500);

    const checkbox = page.locator('input[type="checkbox"]').nth(1);
    await checkbox.waitFor({ state: 'visible', timeout: 10000 });
    await checkbox.check();
    await page.waitForTimeout(800);

    if (VOICE) {
      await page.evaluate((voiceID) => {
        const selects = document.querySelectorAll('select');
        if (selects.length < 3) return;
        const select = selects[2];
        const options = Array.from(select.options);
        let idx = options.findIndex(o => o.value === voiceID || o.text.includes(voiceID));
        if (idx === -1) idx = options.findIndex(o => o.text.includes('Andrea') && o.text.includes('Spanish'));
        if (idx !== -1) {
          select.selectedIndex = idx;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, VOICE);
    }
    await page.waitForTimeout(1000);

    const textarea = page.locator('textarea').nth(1);
    await textarea.waitFor({ state: 'visible', timeout: 10000 });
    await textarea.fill(text);
    await page.waitForTimeout(1000);

    const playBtn = page.locator('button:has-text("Play")').nth(1);
    await playBtn.waitFor({ state: 'visible', timeout: 10000 });
    await playBtn.click();

    console.log(`[Part ${partId}] Waiting for download...`);
    const downloadBtn = page.locator('button:has(svg.lucide-download)').nth(1);
    const filename = `part_${partId}.wav`;
    const filepath = path.join(OUTPUT_DIR, filename);

    const scanStart = Date.now();
    while (Date.now() - scanStart < 180000) {
      try {
        const currentClasses = await downloadBtn.getAttribute('class');
        const isDisabled = await downloadBtn.getAttribute('disabled');
        if (currentClasses && currentClasses.includes('text-green') && isDisabled === null) {
          console.log(`[Part ${partId}] Download ready!`);
          const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
          await downloadBtn.click();
          const download = await downloadPromise;
          await download.saveAs(filepath);
          await page.waitForTimeout(2000);
          if (fs.existsSync(filepath) && fs.statSync(filepath).size > 100) {
            console.log(`[Part ${partId}] SUCCESS: ${(fs.statSync(filepath).size / 1024).toFixed(1)} KB`);
            return filepath;
          }
        }
      } catch (e) {}
      await page.waitForTimeout(2000);
    }
    console.log(`[Part ${partId}] TIMEOUT`);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

/* CARTESIA TTS */
function float32ToWav(chunks, sampleRate = 44100) {
  const raw = Buffer.concat(chunks);
  const sampleCount = Math.floor(raw.length / 4);
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    let value = raw.readFloatLE(i * 4);
    if (!Number.isFinite(value)) value = 0;
    value = Math.max(-1, Math.min(1, value));
    pcm.writeInt16LE(value < 0 ? Math.round(value * 32768) : Math.round(value * 32767), i * 2);
  }
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

async function selectCartesiaMenuItem(page, trigger, searchPlaceholder, wanted, label) {
  await trigger.click();
  await page.waitForTimeout(1000);

  const popup = page.locator('[data-slot="popover-content"]:visible').last();
  try {
    await popup.waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    console.log(`[Cartesia] ${label} dropdown not visible, trying alternative...`);
    const altPopup = page.locator('[role="listbox"]:visible, [role="menu"]:visible, [data-radix-popper-content-wrapper]:visible').last();
    try {
      await altPopup.waitFor({ state: 'visible', timeout: 5000 });
    } catch {
      console.log(`[Cartesia] ${label} dropdown not found at all, skipping`);
      await page.keyboard.press('Escape').catch(() => {});
      return false;
    }
  }

  try {
    const searchInput = popup.getByPlaceholder(searchPlaceholder);
    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.fill(wanted);
      await page.waitForTimeout(800);
    }
  } catch {}

  try {
    const options = popup.getByRole('option');
    const count = await options.count();
    console.log(`[Cartesia] ${label} dropdown has ${count} options`);
    if (count === 0) {
      console.log(`[Cartesia] No ${label} options found, skipping`);
      await page.keyboard.press('Escape').catch(() => {});
      return false;
    }

    const matches = (await options.allInnerTexts()).map(item => item.trim());
    console.log(`[Cartesia] Available ${label}s: ${matches.slice(0, 10).join(', ') || 'none'}`);

    const exactIndex = matches.findIndex(item => item === wanted);
    if (exactIndex === -1) {
      const partialIndex = matches.findIndex(item => item.toLowerCase().includes(wanted.toLowerCase()));
      if (partialIndex !== -1) {
        await options.nth(partialIndex).click();
        console.log(`[Cartesia] ${label} "${wanted}" matched partially: "${matches[partialIndex]}"`);
        return true;
      }
      console.log(`[Cartesia] ${label} "${wanted}" not found, using default`);
      await page.keyboard.press('Escape').catch(() => {});
      return false;
    }
    await options.nth(exactIndex).click();
    return true;
  } catch (e) {
    console.log(`[Cartesia] ${label} selection error: ${e.message}, using default`);
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
}

async function processCartesiaChunk(context, text, partId) {
  const page = await context.newPage();
  try {
    console.log(`[Part ${partId}] Opening Cartesia Sonic...`);
    await page.goto('https://www.cartesia.ai/sonic', { waitUntil: 'networkidle', timeout: 90000 });
    await page.waitForTimeout(5000);

    const acceptCookies = page.getByRole('button', { name: 'Accept', exact: true });
    if (await acceptCookies.isVisible().catch(() => false)) {
      await acceptCookies.click().catch(() => {});
      await page.waitForTimeout(1000);
    }

    const editor = page.locator('[contenteditable="true"].rich-transcript').first();
    try {
      await editor.waitFor({ state: 'visible', timeout: 30000 });
    } catch {
      console.log(`[Part ${partId}] Editor not found with .rich-transcript, trying alternatives...`);
      const altEditor = page.locator('[contenteditable="true"]').first();
      await altEditor.waitFor({ state: 'visible', timeout: 30000 });
    }
    const widget = editor.locator('xpath=ancestor::*[.//button[normalize-space(.)="Play"]][1]');
    const menuTriggers = widget.locator('button[data-slot="popover-trigger"]');

    const triggerCount = await menuTriggers.count();
    console.log(`[Part ${partId}] Found ${triggerCount} menu triggers`);

    if (triggerCount >= 1) {
      const langSelected = await selectCartesiaMenuItem(page, menuTriggers.nth(0), 'Search language\u2026', LANGUAGE, 'Language');
      console.log(`[Part ${partId}] Language selection: ${langSelected ? 'done' : 'default'}`);
      await page.waitForTimeout(1000);
    }

    if (VOICE && triggerCount >= 2) {
      const voiceSelected = await selectCartesiaMenuItem(page, menuTriggers.nth(1), 'Search voices\u2026', VOICE, 'Voice');
      console.log(`[Part ${partId}] Voice selection: ${voiceSelected ? 'done' : 'default'}`);
      await page.waitForTimeout(1000);
    }

    await editor.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.insertText(text);
    await page.waitForTimeout(1000);

    const audioChunks = [];
    let resolveAudio, rejectAudio;
    const audioComplete = new Promise((resolve, reject) => { resolveAudio = resolve; rejectAudio = reject; });
    const audioTimeout = setTimeout(() => rejectAudio(new Error('Audio timeout 60s')), 60000);

    page.on('websocket', ws => {
      if (!ws.url().startsWith('wss://api.cartesia.ai/tts/websocket')) return;
      ws.on('framereceived', event => {
        try {
          if (typeof event.payload !== 'string') return;
          const message = JSON.parse(event.payload);
          if (message.type === 'chunk' && message.data) audioChunks.push(Buffer.from(message.data, 'base64'));
          if (message.type === 'done' || message.done === true) resolveAudio();
          if (message.type === 'error' || (message.status_code && message.status_code >= 400))
            rejectAudio(new Error(message.error || `Cartesia error ${message.status_code}`));
        } catch (_) {}
      });
      ws.on('socketerror', error => rejectAudio(new Error(`WebSocket error: ${error}`)));
    });

    const playBtn = page.getByRole('button', { name: 'Play', exact: true }).first();
    await playBtn.waitFor({ state: 'visible', timeout: 15000 });
    await playBtn.click();
    console.log(`[Part ${partId}] Waiting for audio...`);
    await audioComplete;
    clearTimeout(audioTimeout);

    if (audioChunks.length === 0) throw new Error('No audio chunks received.');

    const filename = `cartesia_part_${partId}.wav`;
    const filepath = path.join(OUTPUT_DIR, filename);
    const wav = float32ToWav(audioChunks, 44100);
    fs.writeFileSync(filepath, wav);

    console.log(`[Part ${partId}] SUCCESS: ${(wav.length / 1024).toFixed(1)} KB`);
    return filepath;
  } finally {
    await page.close().catch(() => {});
  }
}

/* MAIN */
async function main() {
  if (!TEXT) { console.error('TTS_TEXT not set!'); process.exit(1); }

  const chunks = splitText(TEXT);
  if (!chunks.length) { console.error('No text chunks to process!'); process.exit(1); }

  console.log(`\nKUX TTS GitHub Worker`);
  console.log(`   Engine: ${ENGINE}`);
  console.log(`   Parts: ${chunks.length}`);
  console.log(`   Voice: ${VOICE || 'default'}`);
  if (ENGINE === 'cartesia') console.log(`   Language: ${LANGUAGE}`);
  console.log('');

  const browser = await firefox.launch({ headless: true });
  const results = [];

  for (let i = 0; i < chunks.length; i++) {
    const partId = i + 1;
    const context = await browser.newContext();
    try {
      let filepath;
      if (ENGINE === 'kyutai') {
        filepath = await processKyutaiChunk(context, chunks[i], partId);
      } else {
        filepath = await processCartesiaChunk(context, chunks[i], partId);
      }
      results.push({ partId, success: !!filepath, filepath });
    } catch (err) {
      console.error(`[Part ${partId}] FAILED: ${err.message}`);
      results.push({ partId, success: false, error: err.message });
    } finally {
      await context.close().catch(() => {});
    }
  }

  await browser.close();

  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  console.log(`\nDONE: ${succeeded}/${chunks.length} succeeded, ${failed} failed`);
  console.log(`Output: ${path.resolve(OUTPUT_DIR)}`);

  if (succeeded > 0) {
    console.log('\nFiles:');
    for (const r of results.filter(r => r.success)) {
      console.log(`   ${r.filepath}`);
    }
  }

  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
