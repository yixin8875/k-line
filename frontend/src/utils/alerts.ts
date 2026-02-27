let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

export function playDefaultBeep(): void {
  const context = getAudioContext();
  const start = context.currentTime;

  [0, 0.22, 0.44].forEach((offset) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = 'square';
    oscillator.frequency.value = 1280;

    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.35, start + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.16);

    oscillator.connect(gain);
    gain.connect(context.destination);

    oscillator.start(start + offset);
    oscillator.stop(start + offset + 0.17);
  });
}

export function playCustomSound(dataUrl: string): void {
  if (!dataUrl) {
    return;
  }
  const audio = new Audio(dataUrl);
  audio.volume = 1;
  void audio.play();
}

export function speakAlert(text: string): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'zh-CN';
  utterance.rate = 1;
  utterance.pitch = 1;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

export async function notifyBrowser(title: string, body: string): Promise<void> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return;
  }

  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }

  if (Notification.permission === 'granted') {
    new Notification(title, { body });
  }
}
