const puppeteer = require('puppeteer');
const { getStream } = require('puppeteer-stream');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');

class PageCaster {
  constructor() {
    this.validateEnvironment();
    // Auto-set AUDIO_SOURCE to icecast if ICE_URL is provided and AUDIO_SOURCE isn't explicitly set
    this.audioSource = process.env.AUDIO_SOURCE || (process.env.ICE_URL ? 'icecast' : 'silent');
    this.webUrl = process.env.WEB_URL;
    this.rtmpUrl = process.env.RTMP_URL;
    this.iceUrl = process.env.ICE_URL;
    this.screenWidth = parseInt(process.env.SCREEN_WIDTH) || 854;
    this.screenHeight = parseInt(process.env.SCREEN_HEIGHT) || 480;
    this.ffmpegPreset = process.env.FFMPEG_PRESET || 'veryfast';
    this.framerate = parseInt(process.env.FRAMERATE) || 30;
    // Hardware encoding: 'vaapi', 'nvenc', or 'software' (default)
    this.videoEncoder = process.env.VIDEO_ENCODER || 'software';
    this.vaapiDevice = process.env.VAAPI_DEVICE || '/dev/dri/renderD128';

    this.browser = null;
    this.page = null;
    this.ffmpegProcess = null;
    this.audioStream = null;
  }

  validateEnvironment() {
    const required = ['WEB_URL', 'RTMP_URL'];
    const missing = required.filter(env => !process.env[env]);
    
    if (missing.length > 0) {
      console.error(`Missing required environment variables: ${missing.join(', ')}`);
      process.exit(1);
    }
  }


  async setupBrowser() {
    console.log('Starting Puppeteer browser...');
    
    try {
      this.browser = await puppeteer.launch({
        headless: false,  // We want a real window in Xvfb
        ignoreDefaultArgs: ['--enable-automation'],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
        args: [
          '--remote-debugging-port=9222',
          '--no-sandbox',
//          '--debug-print',
          '--disable-logging',
          '--disable-domain-reliability',
          '--disable-setuid-sandbox',
          '--disable-model-download-verification',
          '--disable-notifications',
//          '--disable-software-rasterizer',
//          '--gpu-startup-dialog',
//          '--disable-low-end-device-mode',
//          '--disable-dev-shm-usage',

          // Try to keep rendering unthrottled
          '--autoplay-policy=no-user-gesture-required',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',

          '--enable-features=AcceleratedVideoDecodeLinuxZeroCopyGL,AcceleratedVideoDecodeLinuxGL,VaapiOnNvidiaGPUs',

          // GPU / compositor hints
          '--video-capture-use-gpu-memory-buffer',
          '--ignore-gpu-blocklist',
          '--force-webgpu-compat',
          '--force-video-overlays',
          '--enable-webgl',
          '--enable-webgl2',
          '--enable-gpu',
          '--enable-gpu-rasterization',
          '--enable-gpu-memory-buffer-compositor-resources',
          '--enable-hardware-overlays',
          '--enable-accelerated-2d-canvas',
          '--enable-native-gpu-memory-buffers',
          '--enable-accelerated-video',
          '--enable-accelerated-video-decode',
          '--enable-zero-copy',
          '--enable-features=Vulkan',
          '--disable-vulkan-surface',
          '--enable-unsafe-webgpu',
//          '--use-vulkan',
          '--use-gl=desktop', // simpler than --use-gl=angle/--use-angle=gl-egl on Linux GPU
          '--use-angle=vulkan',
          '--disable-frame-rate-limit',
//          '--frame-rate 30',
          '--force-device-scale-factor=1',
          '--no-first-run',
          '--kiosk',
          '--disable-gpu-vsync',
          '--double-buffer-compositing',

          `--window-size=${this.screenWidth},${this.screenHeight}`,
          '--window-position=0,0',

          // media / security loosening for local content
          '--allow-running-insecure-content',
          '--disable-web-security',
          '--enable-usermedia-screen-capturing',
          '--allow-http-screen-capture',
//          '--use-fake-device-for-media-stream',
//          '--use-fake-ui-for-media-stream',

          // pulseaudio hint (not strictly required but fine)
          '--enable-features=PulseAudio',

          // Capture WebGL Audio
          '--auto-select-desktop-capture-source=WebGLStreamTab'

        ],
        defaultViewport: null,
        env: {
          ...process.env,
          DISPLAY: process.env.DISPLAY || ':99',
          PULSE_SERVER: process.env.PULSE_SERVER || 'unix:/tmp/pulse-socket'
        }
      });
  
      console.log('Browser launched successfully');
  
      this.page = await this.browser.newPage();
      console.log('New page created');
      
      await this.page.setViewport({
        width: this.screenWidth,
        height: this.screenHeight
      });
      console.log('Viewport set');
  
      console.log(`Navigating to: ${this.webUrl}`);
      await this.page.goto(this.webUrl, { 
        waitUntil: 'domcontentloaded',
        timeout: 60000 
      });
      console.log('Page loaded successfully');
  
      // give video/audio elements a moment to settle
      await new Promise(resolve => setTimeout(resolve, 2000));
      console.log('Browser setup complete');
    } catch (error) {
      console.error('Browser setup failed:', error);
      throw error;
    }
  }

  async setupAudioCapture() {
    console.log(`Setting up audio capture (source: ${this.audioSource})`);

    switch (this.audioSource.toLowerCase()) {
      case 'browser':
        return await this.setupWebpageAudio();
      case 'icecast':
        return this.setupIcecastAudio();
      case 'silent':
        return this.setupSilentAudio();
      default:
        console.warn(`Unknown audio source: ${this.audioSource}, falling back to silence`);
        return this.setupSilentAudio();
    }
  }

  async setupWebpageAudio() {
    try {
      console.log('Setting up webpage audio capture via PulseAudio...');
      
      // Wait for page to be fully loaded
      await this.page.waitForFunction(() => document.readyState === 'complete', {timeout: 10000});
      
      // Check what audio elements exist and try to activate them
      const audioInfo = await this.page.evaluate(() => {
        // Resume audio context if it exists
        let audioContextState = 'none';
        if (typeof window.AudioContext !== 'undefined' || typeof window.webkitAudioContext !== 'undefined') {
          const AudioContextClass = window.AudioContext || window.webkitAudioContext;
          const audioContext = new AudioContextClass();
          audioContextState = audioContext.state;
          audioContext.resume();
        }
        
        // Try to play any audio/video elements
        const audioElements = document.querySelectorAll('audio, video');
        const elementInfo = Array.from(audioElements).map(el => ({
          tagName: el.tagName,
          src: el.src || el.currentSrc,
          paused: el.paused,
          muted: el.muted,
          autoplay: el.autoplay
        }));
        
        audioElements.forEach(el => {
          if (el.play) {
            el.play().catch(() => {});
          }
        });
        
        return {
          audioContextState,
          elementCount: audioElements.length,
          elements: elementInfo
        };
      });

      console.log('Audio info on page:', JSON.stringify(audioInfo, null, 2));

      // For webpage audio, always try to capture system audio 
      // (some sites use Web Audio API without HTML audio elements)
      if (audioInfo.audioContextState === 'running' || audioInfo.elementCount > 0) {
        console.log(`Will capture browser audio via PulseAudio (AudioContext: ${audioInfo.audioContextState}, Elements: ${audioInfo.elementCount})`);
        return {
          type: 'stream'
        };
      } else {
        console.log('No audio context or elements found, falling back to silent audio');
        return this.setupSilentAudio();
      }
      
    } catch (error) {
      console.error('Failed to setup webpage audio:', error.message);
      console.log('Falling back to silent audio...');
      return this.setupSilentAudio();
    }
  }

  setupIcecastAudio() {
    if (this.iceUrl) {
      console.log(`Using Icecast audio from: ${this.iceUrl}`);
      return {
        type: 'url',
        source: this.iceUrl
      };
    } else {
      console.log('No ICE_URL provided, falling back to silent audio');
      return this.setupSilentAudio();
    }
  }

  setupSilentAudio() {
    console.log('Using silent audio track');
    return {
      type: 'silent'
    };
  }

  async startScreencast() {
    console.log('Starting screen capture...');
    
    const audioConfig = await this.setupAudioCapture();
    const ffmpegArgs = this.buildFFmpegArgs(audioConfig);
    
    console.log('Starting FFmpeg with args:', ffmpegArgs.join(' '));
    
    this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.ffmpegProcess.stdout.on('data', (data) => {
      console.log(`FFmpeg stdout: ${data}`);
    });

    this.ffmpegProcess.stderr.on('data', (data) => {
      console.log(`FFmpeg stderr: ${data}`);
    });

    this.ffmpegProcess.on('close', (code) => {
      console.log(`FFmpeg process exited with code ${code}`);
      this.cleanup();
    });

    this.ffmpegProcess.on('error', (error) => {
      console.error('FFmpeg process error:', error);
      this.cleanup();
    });

    // FFmpeg handles X11 capture directly - no screenshot loop needed
    console.log('FFmpeg started - X11 screen capture in progress...');
  }

  buildFFmpegArgs(audioConfig) {
    const baseArgs = ['-y'];

    // X11 capture with thread queue for smoother capture
    baseArgs.push(
      '-thread_queue_size', '16',
      '-f', 'x11grab',
      '-r', this.framerate.toString(),
      '-s', `${this.screenWidth}x${this.screenHeight}`,
      '-draw_mouse', '0',
      '-i', ':99.0'
    );

    // Audio input with thread queue
    const audioArgs = [];
    switch (audioConfig.type) {
      case 'url':
        audioArgs.push('-thread_queue_size', '16', '-i', audioConfig.source);
        break;
      case 'stream':
        // Use ALSA instead of pulse (jrottenberg ffmpeg doesn't have pulse support)
        audioArgs.push('-thread_queue_size', '16', '-f', 'alsa', '-i', 'default');
        break;
      case 'silent':
        audioArgs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
        break;
    }

    // Video encoding based on encoder type
    const outputArgs = [];

    if (this.videoEncoder === 'vaapi') {
      outputArgs.push(
        '-vf', 'format=nv12|vaapi,hwupload',
        '-c:v', 'h264_vaapi',
        '-qp', '20',  // Quality parameter for VAAPI (lower = better quality)
        '-bf', '0'    // B-frames
      );
    } else if (this.videoEncoder === 'nvenc') {
      outputArgs.push(
        '-c:v', 'h264_nvenc',
        '-preset', 'p1',  // NVENC preset p1 (fastest encoding)
        '-tune', 'ull',   // Ultra-low latency
        '-rc', 'cbr',     // Constant bitrate
        '-b:v', '3000k',
        '-g', '60',       // GOP size (2 seconds at 30fps)
        '-zerolatency', '1',  // Enable zero latency mode
        '-delay', '0'     // No delay
      );
    } else {
      // Software encoding (libx264)
      outputArgs.push(
        '-c:v', 'libx264',
        '-preset', this.ffmpegPreset,
        '-tune', 'zerolatency'
      );
    }

    // Common output parameters
    outputArgs.push(
      '-maxrate', '3000k',
      '-bufsize', '6000k',
      '-pix_fmt', 'yuv420p',
      '-r', this.framerate.toString(),
      '-vsync', 'cfr',  // Constant frame rate (older FFmpeg compatibility)
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ac', '2',
      '-f', 'flv',
      this.rtmpUrl
    );

    return [...baseArgs, ...audioArgs, ...outputArgs];
  }

  async cleanup() {
    console.log('Cleaning up resources...');
    
    if (this.audioStream) {
      this.audioStream.destroy();
    }
    
    if (this.ffmpegProcess && !this.ffmpegProcess.killed) {
      this.ffmpegProcess.kill('SIGTERM');
    }
    
    if (this.page) {
      await this.page.close();
    }
    
    if (this.browser) {
      await this.browser.close();
    }
  }

  async start() {
    try {
      console.log('Starting PageCaster...');
      console.log(`Audio source: ${this.audioSource}`);
      console.log(`Video encoder: ${this.videoEncoder}`);
      console.log(`Web URL: ${this.webUrl}`);
      console.log(`RTMP URL: ${this.rtmpUrl}`);
      console.log(`Screen size: ${this.screenWidth}x${this.screenHeight}`);
      console.log(`Framerate: ${this.framerate}fps`);

      await this.setupBrowser();
      await this.startScreencast();
      
    } catch (error) {
      console.error('Error starting PageCaster:', error);
      await this.cleanup();
      process.exit(1);
    }
  }
}

process.on('SIGINT', async () => {
  console.log('\nReceived SIGINT, shutting down gracefully...');
  if (global.pageCaster) {
    await global.pageCaster.cleanup();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');
  if (global.pageCaster) {
    await global.pageCaster.cleanup();
  }
  process.exit(0);
});

const pageCaster = new PageCaster();
global.pageCaster = pageCaster;
pageCaster.start();
