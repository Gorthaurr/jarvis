/** Change the brain while preserving the owner's configured hearing and voice. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { parse } = require('dotenv');
const isAudio = (key) => /^(STT_|TTS_|WHISPER_|DEEPGRAM_|ELEVENLABS_|WINDOWS_TTS_|YANDEX_|JARVIS_TTS_|JARVIS_DEEPGRAM_)/u.test(key) && !key.startsWith('YANDEX_MAPS_');

export function buildProfile(source, { brain = 'codex', port = 8788, dataDir, offlineAudio = false }) {
  if (!['codex', 'local'].includes(brain)) throw new Error('Expected codex or local');
  if (!Number.isInteger(Number(port)) || Number(port) < 1024 || Number(port) > 65535) throw new Error('Invalid port');
  const audio = Object.fromEntries(Object.entries(source).filter(([key]) => isAudio(key)));
  if (offlineAudio) {
    for (const key of Object.keys(audio)) audio[key] = '';
    Object.assign(audio, { STT_PROVIDER: 'whisper', WHISPER_MODEL: 'Xenova/whisper-base',
      WHISPER_DEVICE: 'cpu', WHISPER_DTYPE: 'q8', TTS_PROVIDER: 'windows',
      DEEPGRAM_API_KEY: '', ELEVENLABS_API_KEY: '', YANDEX_API_KEY: '' });
  }
  return {
    ...audio, PORT: String(port), HOST: '127.0.0.1', LLM_PROVIDER: brain, CODEX_MODEL: 'gpt-6-luna',
    OLLAMA_BASE_URL: 'http://127.0.0.1:11435', OLLAMA_MODEL: 'qwen3.5:9b-q4_K_M', OLLAMA_CONTEXT: '131072',
    HF_ENDPOINT: source.HF_ENDPOINT || 'https://huggingface.co',
    JARVIS_DATA_DIR: dataDir, DATABASE_URL: `pglite://${dataDir}/pgdata`,
    JARVIS_PRODUCT_MODE: '0', JARVIS_PRIMARY_LLM: '0', JARVIS_SUBSCRIPTION_FALLBACK: '0',
    ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', BRAVE_SEARCH_API_KEY: '',
    JARVIS_AMBIENT_TELEGRAM: '0', JARVIS_AMBIENT_MAIL: '0', JARVIS_AMBIENT_CALENDAR: '0', JARVIS_SKILL_DISTILL: '0',
  };
}

export function serializeProfile(profile) {
  return Object.entries(profile).map(([key, value]) => {
    const text = String(value);
    // dotenv expands literal \n/\r inside double quotes; model paths must round-trip exactly.
    const quote = ["'", '`', '"'].find((q) => !text.includes(q) && !(q === '"' && /\\[nr]/u.test(text)));
    if (!quote || /[\r\n]/u.test(text)) throw new Error(`Unsupported multiline/quoted setting: ${key}`);
    return `${key}=${quote}${text}${quote}`;
  }).join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  let saved = {};
  try { saved = parse(readFileSync(resolve(root, '.env'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const [brain, port, mode] = process.argv.slice(2);
  const dataDir = resolve(root, 'apps/server/data/no-api').replaceAll('\\', '/');
  const profile = buildProfile({ ...process.env, ...saved }, { brain, port, dataDir, offlineAudio: mode === 'offline' });
  writeFileSync(resolve(root, '.env.no-api'), serializeProfile(profile), { mode: 0o600 });
  console.log(`Profile ready: brain=${brain}, audio=${mode === 'offline' ? 'explicit offline' : 'existing settings preserved'}`);
}
