/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export class AudioStreamer {
  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;

  constructor(private sampleRate: number = 16000) {}

  async startRecording(onAudioData: (data: Int16Array) => void) {
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
      sampleRate: this.sampleRate,
    });

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.source = this.audioContext.createMediaStreamSource(this.stream);

    // Using ScriptProcessorNode for simplicity in this environment
    // Buffer size 4096 is a good balance for latency and performance
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      const pcm16 = this.floatToPcm16(inputData);
      onAudioData(pcm16);
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  stopRecording() {
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

  private floatToPcm16(float32Array: Float32Array): Int16Array {
    const pcm16 = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return pcm16;
  }

  // Playback logic
  private playbackContext: AudioContext | null = null;
  private nextStartTime: number = 0;

  async playAudioChunk(base64Data: string) {
    if (!this.playbackContext) {
      this.playbackContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 24000,
      });
      this.nextStartTime = this.playbackContext.currentTime;
    }

    const binaryString = atob(base64Data);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const pcm16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768.0;
    }

    const buffer = this.playbackContext.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);

    const source = this.playbackContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.playbackContext.destination);

    const startTime = Math.max(this.nextStartTime, this.playbackContext.currentTime);
    source.start(startTime);
    this.nextStartTime = startTime + buffer.duration;
  }

  stopPlayback() {
    if (this.playbackContext) {
      this.playbackContext.close();
      this.playbackContext = null;
      this.nextStartTime = 0;
    }
  }

  resumePlayback() {
    if (this.playbackContext && this.playbackContext.state === 'suspended') {
      this.playbackContext.resume();
    }
  }
}
