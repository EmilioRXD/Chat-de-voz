/**
 * VoiceDetector - Detección Automática de Actividad de Voz (VAD)
 * Analiza el volumen del micrófono en tiempo real y detecta cuándo el usuario está hablando
 */
export class VoiceDetector {
    constructor(stream, onVoiceChange) {
        this.stream = stream;
        this.onVoiceChange = onVoiceChange;
        this.audioContext = null;
        this.analyser = null;
        this.microphone = null;
        this.dataArray = null;
        this.isTalking = false;
        this.detectionInterval = null;

        // Configuración de umbrales
        this.threshold = -34; // Umbral para detectar voz (medium)
        this.silenceThreshold = -44; // Umbral para detectar silencio
        this.silenceDelay = 500; // Tiempo antes de marcar como silencio (ms)
        this.lastSpeakTime = 0;

        this.init();
    }

    async init() {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 2048;
            this.analyser.smoothingTimeConstant = 0.8;

            this.microphone = this.audioContext.createMediaStreamSource(this.stream);
            this.microphone.connect(this.analyser);

            this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

            this.startDetection();
            console.log('✓ Voice detector initialized');
        } catch (error) {
            console.error('❌ Voice detector init error:', error);
        }
    }

    /**
     * Calcula el volumen en decibeles (dB)
     */
    getVolumeDb() {
        this.analyser.getByteTimeDomainData(this.dataArray);

        let sum = 0;
        for (let i = 0; i < this.dataArray.length; i++) {
            const v = this.dataArray[i] - 128; // Centrar en 0
            sum += v * v;
        }

        const rms = Math.sqrt(sum / this.dataArray.length);
        const db = 20 * Math.log10(rms / 128);

        return db;
    }

    /**
     * Inicia la detección continua de voz
     */
    startDetection() {
        this.detectionInterval = setInterval(() => {
            const volumeDb = this.getVolumeDb();
            const now = Date.now();

            if (volumeDb > this.threshold) {
                this.lastSpeakTime = now;

                if (!this.isTalking) {
                    this.isTalking = true;
                    this.notifyChange(true, volumeDb);
                }
            } else if (volumeDb < this.silenceThreshold && this.isTalking) {
                if (now - this.lastSpeakTime > this.silenceDelay) {
                    this.isTalking = false;
                    this.notifyChange(false, volumeDb);
                }
            }

            // Siempre notificar el volumen actual para monitoreo
            this.notifyChange(this.isTalking, volumeDb);
        }, 100); // Verificar cada 100ms
    }

    /**
     * Notifica cambios en el estado de voz
     */
    notifyChange(isTalking, volumeDb) {
        if (this.onVoiceChange) {
            this.onVoiceChange(isTalking, volumeDb);
        }
    }

    /**
     * Configura la sensibilidad de detección
     * @param {string} level - 'low', 'medium', o 'high'
     */
    setSensitivity(level) {
        switch (level) {
            case 'low':
                this.threshold = -40;
                this.silenceThreshold = -48;
                break;

            case 'medium':
                this.threshold = -34;
                this.silenceThreshold = -44;
                break;

            case 'high':
                this.threshold = -30;
                this.silenceThreshold = -42;
                break;

            default:
                console.warn(`Unknown sensitivity level: ${level}, using medium`);
                this.threshold = -34;
                this.silenceThreshold = -44;
        }

        console.log(`🎚️ Sensitivity set to ${level}: threshold=${this.threshold}dB`);
    }

    /**
     * Limpia recursos del detector
     */
    dispose() {
        if (this.detectionInterval) {
            clearInterval(this.detectionInterval);
        }

        if (this.microphone) {
            this.microphone.disconnect();
        }

        if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close();
        }

        console.log('✓ Voice detector disposed');
    }
}
