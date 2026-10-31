import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, lstat, unlink, rmdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fail = (code, message) => Object.assign(new Error(message), { code });
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

/** Local Edge TTS boundary. No process or filesystem work occurs until synthesize. */
export function createSpeechSynthesizer({
  python,
  voice = 'zh-CN-XiaoxiaoNeural',
  tempDir = tmpdir(),
  timeoutMs = 20000,
  maxChars = 300,
  maxBytes = 3 * 1024 * 1024,
  maxConcurrent = 1,
  spawnImpl = spawn,
} = {}) {
  if (typeof voice !== 'string' || !/^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/.test(voice)) {
    throw fail('SPEECH_INVALID_VOICE', '语音名称格式无效');
  }
  if (typeof python !== 'string' || !python.trim() || python.includes('\0') ||
      typeof tempDir !== 'string' || !tempDir || tempDir.includes('\0') ||
      ![timeoutMs, maxChars, maxBytes, maxConcurrent].every(positiveInteger) ||
      timeoutMs > 2147483647 || typeof spawnImpl !== 'function') {
    throw fail('SPEECH_INVALID_CONFIG', '语音合成配置无效');
  }
  let active = 0;
  return { async synthesize(text) {
    if (typeof text !== 'string' || !text.trim() || text.includes('\0')) {
      throw fail('SPEECH_INVALID_TEXT', '语音文本不能为空或包含空字符');
    }
    if (Array.from(text).length > maxChars) throw fail('SPEECH_TEXT_TOO_LONG', '语音文本超过长度限制');
    if (active >= maxConcurrent) throw fail('SPEECH_BUSY', '语音合成繁忙');
    active++;
    let directory;
    let textPath;
    let outputPath;
    let cleanupTask;
    const cleanup = () => {
      if (!cleanupTask) cleanupTask = (async () => {
        for (const file of [textPath, outputPath]) {
          if (file) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
        if (directory) await rmdir(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
      })().catch(() => {
        cleanupTask = undefined;
        throw fail('SPEECH_CLEANUP_FAILED', '语音临时文件清理失败');
      });
      return cleanupTask;
    };
    try {
      directory = await mkdtemp(path.join(tempDir, 'qqbot-speech-'));
      await chmod(directory, 0o700);
      textPath = path.join(directory, 'text.txt');
      outputPath = path.join(directory, 'output.mp3');
      await writeFile(textPath, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      let child;
      try {
        child = spawnImpl(python, [
          '-m', 'edge_tts', '--voice', voice, '--file', textPath,
          '--write-media', outputPath, '--no-progress',
        ], { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
      } catch {
        throw fail('SPEECH_PROCESS_FAILED', '语音合成进程启动失败');
      }
      // Ignore stderr at the OS boundary: no private diagnostics are collected or returned.
      let timer;
      let closeHandler;
      let errorHandler;
      const exited = new Promise(resolve => {
        closeHandler = (code, signal) => resolve({ code, signal });
        errorHandler = () => resolve({ error: true });
        child.once('close', closeHandler);
        child.once('error', errorHandler);
      });
      try {
        const result = await Promise.race([
          exited,
          new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), timeoutMs); }),
        ]);
        if (result.timeout) {
          try { child.kill('SIGTERM'); } catch { /* Still attempt forced termination below. */ }
          const waitForExit = async () => {
            let graceTimer;
            try {
              return await Promise.race([exited, new Promise(resolve => { graceTimer = setTimeout(() => resolve(null), 250); })]);
            } finally { clearTimeout(graceTimer); }
          };
          if (!await waitForExit()) {
            try { child.kill('SIGKILL'); } catch { /* Cleanup remains bounded even when killing fails. */ }
            await waitForExit();
          }
          throw fail('SPEECH_TIMEOUT', '语音合成超时');
        }
        if (result.error || result.code !== 0 || result.signal) throw fail('SPEECH_PROCESS_FAILED', '语音合成失败');
      } finally {
        clearTimeout(timer);
        child.removeListener('close', closeHandler);
        // Keep a no-op error listener for late spawn errors after a bounded timeout.
        child.removeListener('error', errorHandler);
        child.on('error', () => {});
      }
      const info = await lstat(outputPath).catch(() => null);
      if (!info || !info.isFile() || info.size <= 0 || info.size > maxBytes) {
        throw fail('SPEECH_INVALID_OUTPUT', '语音输出文件无效或超过大小限制');
      }
      return { path: outputPath, cleanup };
    } catch (error) {
      await cleanup();
      if (error.code?.startsWith('SPEECH_')) throw error;
      throw fail('SPEECH_FAILED', '语音合成失败');
    } finally {
      active--;
    }
  } };
}
