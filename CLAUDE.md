# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pagecaster streams web browser content to RTMP servers using Puppeteer (headless Chromium) and FFmpeg. It supports three audio source modes:
- **browser**: Captures audio directly from the webpage via PulseAudio
- **icecast**: Uses an external Icecast stream as audio source
- **silent**: Generates silent audio track for video-only streaming

A 480p stream typically consumes about half a CPU core and 300MB of RAM.

## Development Commands

```bash
# Start the application (requires Docker environment with X11/PulseAudio)
npm start

# Development with auto-reload
npm run dev

# Build and run Docker container locally
docker build -t pagecaster .
docker run -d \
  --shm-size=256m \
  -e WEB_URL="https://example.com" \
  -e AUDIO_SOURCE="browser" \
  -e RTMP_URL="rtmp://server:1935/live" \
  pagecaster
```

Note: The application is designed to run in Docker with X11 (via Xvfb) and PulseAudio configured. Running locally requires:
- X11 display server on :99
- PulseAudio with virtual-audio sink
- Chromium browser
- FFmpeg

## Architecture

### Entry Point & Orchestration
- **entrypoint.sh**: Bash script that sets up the runtime environment before starting Node.js
  - Configures Xvfb (X11 virtual framebuffer) on display :99
  - Sets up PulseAudio with virtual audio sink for browser audio capture
  - Validates required environment variables (WEB_URL, RTMP_URL)
  - Launches src/index.js

### Core Application (src/index.js)
Single-file application structured as a `PageCaster` class with distinct phases:

1. **Environment Validation** (constructor, validateEnvironment)
   - Auto-detects audio source: if ICE_URL is set, defaults to 'icecast', otherwise 'silent'
   - Loads configuration from environment variables

2. **Browser Setup** (setupBrowser)
   - Launches Puppeteer in non-headless mode with X11 display
   - Uses kiosk mode for clean capture without browser chrome
   - Configures viewport to match SCREEN_WIDTH x SCREEN_HEIGHT
   - Key Chromium flags:
     - `--autoplay-policy=no-user-gesture-required`: Allows audio to play without user interaction
     - `--enable-features=PulseAudio`: Routes audio through PulseAudio
     - `--kiosk`: Full-screen mode

3. **Audio Configuration** (setupAudioCapture, setupWebpageAudio, setupIcecastAudio, setupSilentAudio)
   - **Browser mode**: Detects Web Audio API contexts and HTML audio elements, falls back to silent if none found
   - **Icecast mode**: Pulls audio from external URL via FFmpeg
   - **Silent mode**: Generates null audio source
   - Returns audio config object used by FFmpeg builder

4. **Screen & Audio Streaming** (startScreencast, buildFFmpegArgs)
   - Uses FFmpeg with X11 capture (`x11grab`) to grab screen content from :99.0
   - Audio input varies by mode:
     - Browser: `-f pulse -i virtual-audio.monitor` (PulseAudio monitor)
     - Icecast: `-i <ICE_URL>` (HTTP stream)
     - Silent: `-f lavfi -i anullsrc` (null audio generator)
   - Encodes video with libx264, audio with AAC
   - Outputs FLV to RTMP server

5. **Lifecycle Management** (cleanup, signal handlers)
   - Graceful shutdown on SIGINT/SIGTERM
   - Cleans up FFmpeg process, browser page, and Puppeteer instance

### Key Technical Details

**Audio Capture Flow (Browser Mode)**:
- Chromium sends audio to PulseAudio's virtual-audio sink (configured in entrypoint.sh)
- FFmpeg captures from virtual-audio.monitor (the monitoring source)
- Page evaluator activates Web Audio API and plays audio/video elements

**Screen Capture Flow**:
- Xvfb creates virtual X11 display :99 at configured resolution
- Puppeteer launches Chromium on :99 in kiosk mode
- FFmpeg uses x11grab to capture frames directly from :99.0
- No screenshot loop needed—FFmpeg handles frame capture at specified framerate

**Docker Environment**:
- Alpine Linux base with Node.js 24
- System dependencies: chromium, xvfb, ffmpeg, pulseaudio
- Puppeteer configured to use system Chromium (not bundled version)
- Requires `--shm-size=256m` for Chromium's shared memory

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| WEB_URL | Yes | - | URL to stream |
| RTMP_URL | Yes | - | RTMP destination |
| AUDIO_SOURCE | No | Auto | 'browser', 'icecast', or 'silent' (auto: icecast if ICE_URL set, else silent) |
| ICE_URL | Conditional | - | Required if AUDIO_SOURCE=icecast |
| SCREEN_WIDTH | No | 854 | Browser viewport width |
| SCREEN_HEIGHT | No | 480 | Browser viewport height |
| FFMPEG_PRESET | No | veryfast | FFmpeg encoding preset |
| FRAMERATE | No | 30 | Video framerate (fps) |

## Common Patterns

**Audio Source Selection Logic** (src/index.js:12):
```javascript
this.audioSource = process.env.AUDIO_SOURCE || (process.env.ICE_URL ? 'icecast' : 'silent');
```

**FFmpeg Configuration** (src/index.js:219-261):
- Video input: X11 capture at specified framerate and resolution
- Audio input: Varies by audio config type (stream/url/silent)
- Output: H.264 video + AAC audio muxed to FLV for RTMP

**Browser Audio Detection** (src/index.js:111-142):
- Evaluates page for AudioContext and audio/video elements
- Attempts to resume AudioContext and play media elements
- Only uses PulseAudio capture if audio is actually detected
