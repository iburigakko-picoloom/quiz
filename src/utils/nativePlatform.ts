import { Clipboard } from '@capacitor/clipboard';
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { ClipboardCopyError, copyBrowserText } from './clipboardCopy';

export async function writeClipboardText(value: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await Clipboard.write({ string: value });
    return;
  }

  await copyBrowserText(value);
}

export async function writePreparedClipboardText(ready: Promise<string>): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const value = await ready;
    try { await Clipboard.write({ string: value }); } catch { throw new ClipboardCopyError(); }
    return;
  }
  await copyBrowserText(ready);
}

export async function readClipboardText(): Promise<string> {
  if (Capacitor.isNativePlatform()) {
    const result = await Clipboard.read();
    return result.value;
  }
  return navigator.clipboard.readText();
}

export async function saveJsonBackup(fileName: string, jsonText: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const file = await Filesystem.writeFile({
      path: fileName,
      data: jsonText,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });
    await Share.share({
      title: 'QuizMake バックアップ',
      text: 'QuizMakeのバックアップファイルです。',
      url: file.uri,
      dialogTitle: 'バックアップを保存・共有',
    });
    return;
  }

  const blob = new Blob([jsonText], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
