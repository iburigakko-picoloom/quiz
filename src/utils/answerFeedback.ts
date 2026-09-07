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
export function playAnswerFeedback(kind: 'correct' | 'relearned' | 'wrong'): void {
  if (kind === 'wrong' || !isAnswerSoundEnabled()) return;
  try {
    context ??= new AudioContext();
    const audio = context;
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
