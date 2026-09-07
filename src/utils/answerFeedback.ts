export const ANSWER_SOUND_KEY = 'quiz-make-answer-sound';
export function isAnswerSoundEnabled(): boolean {
  try { return localStorage.getItem(ANSWER_SOUND_KEY) !== 'off'; } catch { return true; }
}
export function setAnswerSoundEnabled(enabled: boolean): void {
  localStorage.setItem(ANSWER_SOUND_KEY, enabled ? 'on' : 'off');
}
export function getAnswerFeedback(previousCorrect: boolean | null | undefined, correct: boolean): 'correct' | 'relearned' | 'wrong' {
  return !correct ? 'wrong' : previousCorrect === false ? 'relearned' : 'correct';
}
let context: AudioContext | undefined;

function getAudioContext(): AudioContext {
  if (!context || context.state === 'closed') {
    const AudioContextClass = globalThis.AudioContext
      ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) throw new Error('Audio is unavailable');
    context = new AudioContextClass();
  }
  return context;
}

// Call directly from a user gesture, before saving or rendering the answer.
export function prepareAnswerAudio(): void {
  if (!isAnswerSoundEnabled()) return;
  try {
    const audio = getAudioContext();
    if (audio.state === 'running') return;
    void audio.resume().catch(() => undefined);
    const source = audio.createBufferSource();
    source.buffer = audio.createBuffer(1, 1, audio.sampleRate);
    source.connect(audio.destination);
    source.onended = () => source.disconnect();
    source.start();
  } catch { /* Audio must never prevent selecting or saving an answer. */ }
}

export function playAnswerFeedback(kind: 'correct' | 'relearned' | 'wrong'): void {
  if (kind === 'wrong' || !isAnswerSoundEnabled()) return;
  try {
    const audio = getAudioContext();
    const play = () => {
      const start = audio.currentTime;
      const gain = audio.createGain();
      gain.gain.value = 0.7;
      gain.connect(audio.destination);
      const duration = kind === 'relearned' ? 0.76 : 0.54;
      for (const [frequency, delay] of kind === 'relearned' ? [[660, 0], [880, 0.11]] : [[784, 0]]) {
        const oscillator = audio.createOscillator();
        const envelope = audio.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        envelope.gain.setValueAtTime(0, start + delay);
        envelope.gain.linearRampToValueAtTime(0.12, start + delay + 0.018);
        envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        oscillator.connect(envelope); envelope.connect(gain);
        oscillator.start(start + delay); oscillator.stop(start + duration);
        oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
      }
      window.setTimeout(() => gain.disconnect(), (duration + .1) * 1000);
    };
    if (audio.state === 'running') play();
    else void audio.resume().then(play).catch(() => undefined);
  } catch { /* Playback failure must never block an answer. */ }
}
