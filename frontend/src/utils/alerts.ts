let audioContext: AudioContext | null = null;
let unlockListenersInstalled = false;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined' || typeof AudioContext === 'undefined') {
    return null;
  }
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

function installAudioUnlockListeners(): void {
  if (unlockListenersInstalled || typeof window === 'undefined') {
    return;
  }

  unlockListenersInstalled = true;
  const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart'];

  const cleanup = () => {
    events.forEach((eventName) => {
      window.removeEventListener(eventName, onUserGesture);
    });
  };

  const onUserGesture = () => {
    const context = getAudioContext();
    if (!context) {
      cleanup();
      return;
    }

    if (context.state === 'running') {
      cleanup();
      return;
    }

    void context
      .resume()
      .then(() => {
        if (context.state === 'running') {
          cleanup();
        }
      })
      .catch(() => {
        // Keep listeners so the next user gesture can try again.
      });
  };

  events.forEach((eventName) => {
    window.addEventListener(eventName, onUserGesture, { passive: true });
  });
}

function scheduleBeep(context: AudioContext): void {
  const start = context.currentTime + 0.01;

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

export async function playDefaultBeep(): Promise<boolean> {
  installAudioUnlockListeners();
  const context = getAudioContext();
  if (!context) {
    return false;
  }

  if (context.state === 'running') {
    scheduleBeep(context);
    return true;
  }

  try {
    await context.resume();
    scheduleBeep(context);
    return true;
  } catch {
    // Audio is still locked by runtime policy.
  }

  return false;
}

export async function playCustomSound(dataUrl: string): Promise<boolean> {
  if (!dataUrl) {
    return false;
  }

  installAudioUnlockListeners();
  const audio = new Audio(dataUrl);
  audio.volume = 1;
  try {
    await audio.play();
    return true;
  } catch {
    // Ignore autoplay blocking, user can unlock audio by interacting with the UI.
    return false;
  }
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

installAudioUnlockListeners();
