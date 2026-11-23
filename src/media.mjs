import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import { put } from '@vercel/blob';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.resolve(__dirname, '../public/uploads');

const THEME_ART_HINTS = {
  DARK_NEBULA: 'deep midnight cosmic indigo background (#0b132b to #1e1b4b), luminous glowing accents, clean modern editorial vector illustration',
  CLEAN_LIGHT: 'clean soft ivory and light slate background (#f8fafc to #e2e8f0), crisp minimalist editorial vector illustration, bright airy daylight feel',
  TECH_GRID: 'dark obsidian tech grid backdrop (#030712 to #0b192e), cyan and indigo glowing futuristic line art, modern clean vector illustration',
};

/**
 * Save image bytes either to Vercel Blob (when BLOB_READ_WRITE_TOKEN is configured)
 * or to local public/uploads/ for local Node development.
 */
export async function saveImageBuffer({ buffer, contentType = 'image/png', filenamePrefix = 'slide' }) {
  const ext = contentType.includes('svg')
    ? 'svg'
    : contentType.includes('webp')
      ? 'webp'
      : contentType.includes('jpeg') || contentType.includes('jpg')
        ? 'jpg'
        : 'png';
  const safePrefix = String(filenamePrefix || 'slide').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'slide';
  const uniqueName = `sdi/${safePrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`;

  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const blob = await put(uniqueName, buffer, {
      access: 'public',
      contentType,
      addRandomSuffix: false,
    });
    return { url: blob.url, storage: 'vercel-blob' };
  }

  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const localFile = `${safePrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, localFile), buffer);
  return { url: `/uploads/${localFile}`, storage: 'local' };
}

/**
 * Decode a base64 data URL (e.g. data:image/webp;base64,...) and store it.
 */
export async function saveDataUrlImage({ dataUrl, filenamePrefix = 'upload' }) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/i);
  if (!match) {
    throw new Error('不支援的圖片格式，僅接受 PNG / JPEG / WebP Base64 資料');
  }
  const contentType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 4 * 1024 * 1024) {
    throw new Error('單張圖片超過 4 MB 上限，請壓縮後再上傳');
  }
  return saveImageBuffer({ buffer, contentType, filenamePrefix });
}

function extractImageFromInteraction(interaction) {
  let imgData = interaction?.output_image?.data || '';
  let mimeType = interaction?.output_image?.mime_type || 'image/png';
  if (!imgData && Array.isArray(interaction?.steps)) {
    for (const step of interaction.steps) {
      for (const item of step?.content || []) {
        if (item?.type === 'image' && item?.data) {
          imgData = item.data;
          mimeType = item.mime_type || 'image/png';
        }
      }
    }
  }
  return imgData ? { imgData, mimeType } : null;
}

function sanitizeSvgMarkup(rawText) {
  const match = String(rawText || '').match(/<svg[\s\S]*?<\/svg>/i);
  if (!match) return '';
  let svg = match[0]
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  if (!/\bxmlns=/.test(svg)) {
    svg = svg.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return svg;
}

/**
 * Generate a presentation slide illustration:
 * 1) Tries Nano Banana image models (`gemini-nano-banana-2.1`, `gemini-3.1-flash-lite-image`)
 * 2) If the API key is on Free Tier (limit: 0 for raster image models), falls back seamlessly
 *    to `gemini-4-hydrogen` to craft a high-craft custom vector SVG illustration!
 */
export async function generateSlideIllustration({
  apiKey,
  prompt = '',
  title = '',
  subtitle = '',
  bgTheme = 'DARK_NEBULA',
  primaryColor = '#6366f1',
}) {
  const resolvedKey = String(apiKey || process.env.GEMINI_API_KEY || '').trim();
  if (!resolvedKey) {
    throw new Error('尚未設定 GEMINI_API_KEY，請於 Vercel 環境變數設定或在後台輸入您的 Gemini API Key');
  }

  const concept = String(prompt || '').trim() || `${title}${subtitle ? ' — ' + subtitle : ''}`.trim();
  if (!concept) {
    throw new Error('請輸入插圖描述或確保頁面有標題');
  }

  const styleHint = THEME_ART_HINTS[bgTheme] || THEME_ART_HINTS.DARK_NEBULA;
  const fullPrompt =
    `Create a high-craft presentation slide illustration representing: "${concept}". ` +
    `Visual style: ${styleHint}, accent color ${primaryColor}, clean composition, generous negative space, NO cluttered text or watermarks, suitable for a keynote lecture slide.`;

  const ai = new GoogleGenAI({ apiKey: resolvedKey });
  let lastErr = null;

  for (const model of ['gemini-nano-banana-2.1', 'gemini-3.1-flash-lite-image']) {
    try {
      const interaction = await ai.interactions.create({ model, input: fullPrompt });
      const extracted = extractImageFromInteraction(interaction);
      if (extracted) {
        const buffer = Buffer.from(extracted.imgData, 'base64');
        const saved = await saveImageBuffer({
          buffer,
          contentType: extracted.mimeType,
          filenamePrefix: 'ai_illus',
        });
        return { ...saved, model };
      }
    } catch (err) {
      lastErr = err;
    }
  }

  // Fallback for Gemini Free Tier keys: generate custom editorial SVG vector illustration via gemini-4-hydrogen
  const svgPrompt =
    `You are a keynote presentation graphic designer. Output ONLY raw valid <svg viewBox="0 0 800 600" xmlns="http://www.w3.org/2000/svg">...</svg> code (no markdown fences, no commentary) creating a rich, modern editorial vector illustration for the slide concept: "${concept}".\n` +
    `Design rules:\n` +
    `- Style: ${styleHint}, primary accent ${primaryColor}, complementary cyan (#38bdf8), amber (#fbbf24), emerald (#34d399).\n` +
    `- Use linearGradient/radialGradient, layered rounded cards, subtle glow filters, geometric metaphors, and expressive vector icons/scenes.\n` +
    `- Keep text minimal (0 to 3 short labels max in Traditional Chinese or English; no overlapping text).\n` +
    `- Do NOT include <script>, external images, or event handlers.`;

  try {
    const svgInteraction = await ai.interactions.create({
      model: 'gemini-4-hydrogen',
      input: svgPrompt,
      generation_config: { thinking_level: 'low' },
    });
    const svgText = sanitizeSvgMarkup(svgInteraction?.output_text || '');
    if (svgText) {
      const saved = await saveImageBuffer({
        buffer: Buffer.from(svgText, 'utf8'),
        contentType: 'image/svg+xml',
        filenamePrefix: 'ai_svg',
      });
      return { ...saved, model: 'gemini-4-hydrogen (SVG)' };
    }
  } catch (svgErr) {
    throw new Error(svgErr?.message || lastErr?.message || 'AI 生圖失敗');
  }

  throw new Error(lastErr?.message || 'Gemini 未回傳圖片內容，請調整描述後再試');
}

/**
 * Use fast text model (gemini-3.5-flash-lite) to turn dry slide titles/bullets into
 * vivid visual metaphor prompts for external AI image generators.
 */
export async function generateBatchImagePrompts({
  apiKey,
  slides = [],
  styleLabel = '現代扁平向量插畫',
  bgTheme = 'DARK_NEBULA',
  primaryColor = '#6366f1',
}) {
  const resolvedKey = String(apiKey || process.env.GEMINI_API_KEY || '').trim();
  if (!resolvedKey) {
    throw new Error('尚未設定 GEMINI_API_KEY，將直接使用投影片標題組成提示詞');
  }
  if (!slides.length) return [];

  const listText = slides
    .map((s) => `order=${s.order} | layout=${s.layout} | title=${s.title} | subtitle=${s.subtitle || ''} | body=${String(s.body || '').slice(0, 120)}`)
    .join('\n');

  const prompt =
    `你是一位簡報視覺總監。請為以下簡報頁面各構思一句「具體、有畫面感的視覺隱喻插圖描述」（繁體中文，每句 25~45 字，不要包含圖中文字或條列）。\n` +
    `整體風格：${styleLabel}，背景氛圍：${bgTheme}，主色票：${primaryColor}。\n` +
    `請嚴格只回傳 JSON 陣列（不要 Markdown 圍欄），格式：[{"order":1,"prompt":"..."}]\n\n` +
    `投影片清單：\n${listText}`;

  const ai = new GoogleGenAI({ apiKey: resolvedKey });
  const res = await ai.interactions.create({
    model: 'gemini-3.5-flash-lite',
    input: prompt,
  });

  const text = String(res?.output_text || '').trim();
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('無法解析 AI 回傳的提示詞 JSON');
  const parsed = JSON.parse(jsonMatch[0]);
  return Array.isArray(parsed) ? parsed : [];
}
