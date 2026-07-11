/** Live camera capture: rear camera, throttled frame grabs, optional torch. */
import { CpError } from '../core/errors';

export interface CameraSession {
  readonly torchAvailable: boolean;
  setTorch(on: boolean): Promise<void>;
  stop(): void;
}

const FRAME_INTERVAL_MS = 160;
const MAX_CAPTURE_WIDTH = 1600;

export async function startCamera(
  video: HTMLVideoElement,
  onFrame: (imageData: ImageData, canvas: HTMLCanvasElement) => Promise<void>,
): Promise<CameraSession> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
  } catch (e) {
    const name = e instanceof DOMException ? e.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new CpError('INTERNAL', 'Camera permission was denied. You can import photos of the pages instead.');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new CpError('INTERNAL', 'No camera found on this device. Import photos of the pages instead.');
    }
    throw new CpError('INTERNAL', 'Could not start the camera. Import photos of the pages instead.');
  }

  video.srcObject = stream;
  video.setAttribute('playsinline', 'true');
  await video.play();

  const [track] = stream.getVideoTracks();
  const capabilities = (track.getCapabilities?.() ?? {}) as { torch?: boolean };
  const torchAvailable = capabilities.torch === true;

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  let running = true;
  let busy = false;
  let lastTick = 0;

  const grab = async (): Promise<void> => {
    if (!running || busy) return;
    const now = performance.now();
    if (now - lastTick < FRAME_INTERVAL_MS) return;
    lastTick = now;
    if (!video.videoWidth) return;
    busy = true;
    try {
      const scale = Math.min(1, MAX_CAPTURE_WIDTH / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      await onFrame(imageData, canvas);
    } finally {
      busy = false;
    }
  };

  const scheduleNext = (): void => {
    if (!running) return;
    if ('requestVideoFrameCallback' in video) {
      (video as HTMLVideoElement & {
        requestVideoFrameCallback(cb: () => void): number;
      }).requestVideoFrameCallback(() => {
        void grab().finally(scheduleNext);
      });
    } else {
      setTimeout(() => void grab().finally(scheduleNext), FRAME_INTERVAL_MS);
    }
  };
  scheduleNext();

  return {
    torchAvailable,
    async setTorch(on: boolean): Promise<void> {
      if (!torchAvailable) return;
      await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
    },
    stop(): void {
      running = false;
      for (const t of stream.getTracks()) t.stop();
      video.srcObject = null;
    },
  };
}
