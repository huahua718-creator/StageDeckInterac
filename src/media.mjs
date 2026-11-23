import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import { put } from '@vercel/blob';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.resolve(__dirname, '../public/uploads');

const THEME_ART_HINTS = {
  DARK_NEBULA: 'deep midnight cosmic indigo background, luminous glowing accents, clean modern editorial vector illustration',
  CLEAN_LIGHT: 'clean soft ivory and light slate background, crisp minimalist editorial vector illustration, bright airy daylight feel',
  TECH_GRID: 'dark obsidian tech grid backdrop, cyan and indigo glowing futuristic line art, modern clean vector illustration',
};

/**
 * Save image bytes either to Vercel Blob (when BLOB_READ_WRITE_TOKEN is configured)
 * or to local public/uploads/ for local Node development.
 */
export async function saveImageBuffer({ buffer, contentType = 'image/png', filenamePrefix = 'slide' }) {
  const ext = contentType.includes('webp')
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

/**
 * Generate a presentation slide illustration using Gemini Nano Banana 2.1 (`gemini-nano-banana-2.1`)
 * via the official @google/genai Interactions API, and store it in Vercel Blob / local uploads.
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
  const interaction = await ai.interactions.create({
    model: 'gemini-nano-banana-2.1',
    input: fullPrompt,
  });

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

  if (!imgData) {
    throw new Error('Gemini 未回傳圖片內容，請調整描述後再試');
  }

  const buffer = Buffer.from(imgData, 'base64');
  return saveImageBuffer({
    buffer,
    contentType: mimeType,
    filenamePrefix: 'ai_illus',
  });
}
