// Derived from Noodle, Copyright 2026 Petko D. Petkov (pdp), Apache-2.0.
// Reference caa67e6bf223bf9e097338e7d06404862de40d4c; see third_party/NoodleVoice.
// Dexter changes: closed local origin/CSP and private message handler; no remote page.
import Foundation

enum CodexNativeVoicePage {
 static let origin = URL(string: "https://voice.dexter.invalid/")!
 static let page = """
    <!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; media-src blob:; connect-src 'none'"></head><body><audio id="voice" autoplay></audio><script>
    let peer, microphone, source, context, gain;
    let closed = false, microphoneGeneration = 0, audioMuted = false, playingVoice = false, reportedReady = false;
    function failed() { if (!closed) window.webkit.messageHandlers.dexterVoice.postMessage({failed: true}); }
    function ready() {
      if (!closed && !reportedReady && microphone && source && peer && peer.connectionState === 'connected' && playingVoice && context.state === 'running') {
        reportedReady = true;
        window.webkit.messageHandlers.dexterVoice.postMessage({connected: true});
      }
    }
    async function playVoice() {
      if (closed) return;
      try {
        await document.getElementById('voice').play();
        if (closed) return;
        playingVoice = true;
        ready();
      } catch { failed(); }
    }
    // Permission requests cannot be cancelled. Stop their tracks if their call or route ended
    // while permission was pending, rather than connecting a stale microphone to the mixer.
    async function capture(processVoice) {
      const generation = ++microphoneGeneration;
      const stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: processVoice, noiseSuppression: processVoice, autoGainControl: processVoice}});
      if (closed || generation !== microphoneGeneration) {
        stream.getTracks().forEach(track => track.stop());
        return null;
      }
      return {stream, generation};
    }
    function useMicrophone(captured) {
      if (!captured) return false;
      const {stream, generation} = captured;
      // Awaiting capture yields once more after its helper resolves. Recheck here as hangup
      // or another route request can run between permission completion and attachment.
      if (closed || generation !== microphoneGeneration) {
        stream.getTracks().forEach(track => track.stop());
        return false;
      }
      if (microphone) microphone.getTracks().forEach(track => track.stop());
      if (source) source.disconnect();
      microphone = stream;
      source = null;
      return true;
    }
    // A device whose system cancels echo itself passes false, keeping WebKit's own voice
    // processing, which narrows playback to a phone line, off.
    async function offer(processVoice = true) {
      if (!useMicrophone(await capture(processVoice))) return null;
      context = new AudioContext();
      // iOS pauses the context whenever the device changes its audio set-up, as on switching to
      // the loudspeaker; paused, nothing reaches the bot, so it resumes at once.
      context.onstatechange = () => {
        if (!closed && (context.state === 'suspended' || context.state === 'interrupted')) context.resume().catch(failed);
        ready();
      };
      await context.resume();
      if (closed) return null;
      const destination = context.createMediaStreamDestination();
      gain = context.createGain();
      gain.gain.value = audioMuted ? 0 : 1;
      source = context.createMediaStreamSource(microphone);
      source.connect(gain).connect(destination);
      const noise = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
      const samples = noise.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = (Math.random() * 2 - 1) * 0.002;
      const floor = context.createBufferSource();
      floor.buffer = noise; floor.loop = true; floor.connect(destination); floor.start();
      peer = new RTCPeerConnection();
      destination.stream.getAudioTracks().forEach(track => peer.addTrack(track, destination.stream));
      peer.createDataChannel('oai-events');
      peer.ontrack = event => {
        if (closed) return;
        const voice = document.getElementById('voice');
        voice.srcObject = event.streams[0];
        playingVoice = false;
        playVoice();
      };
      peer.onconnectionstatechange = () => { if (peer.connectionState === 'failed') failed(); else ready(); };
      await peer.setLocalDescription(await peer.createOffer());
      if (closed) return null;
      await new Promise(resolve => {
        if (peer.iceGatheringState === 'complete') return resolve();
        peer.onicegatheringstatechange = () => { if (peer.iceGatheringState === 'complete') resolve(); };
        setTimeout(resolve, 3000);
      });
      return closed ? null : peer.localDescription.sdp;
    }
    async function answer(sdp) { await peer.setRemoteDescription({type: 'answer', sdp}); }
    // Swap the microphone for one with voice processing on or off, mid-call, in two steps so the
    // device can change its audio set-up in between. The noise floor keeps audio flowing meanwhile.
    function stopMicrophone() {
      ++microphoneGeneration;
      if (microphone) microphone.getTracks().forEach(track => track.stop());
      if (source) source.disconnect();
      microphone = null;
      source = null;
    }
    async function startMicrophone(processVoice) {
      if (!useMicrophone(await capture(processVoice))) return;
      source = context.createMediaStreamSource(microphone);
      source.connect(gain);
      if (context.state !== 'running') await context.resume();
      if (closed) return;
      // The device pauses the bot's voice too when it changes its audio set-up.
      const voice = document.getElementById('voice');
      if (voice.srcObject) await playVoice();
    }
    function mute(muted) { audioMuted = muted; if (gain) gain.gain.value = muted ? 0 : 1; }
    // Played on the speakers, not into the call, so the bot never hears it.
    function chime() {
      if (closed || !context) return;
      const start = context.currentTime;
      [[660, 0], [880, 0.13]].forEach(([frequency, offset]) => {
        const tone = context.createOscillator(), level = context.createGain();
        tone.type = 'sine';
        tone.frequency.value = frequency;
        level.gain.setValueAtTime(0, start + offset);
        level.gain.linearRampToValueAtTime(0.18, start + offset + 0.02);
        level.gain.exponentialRampToValueAtTime(0.001, start + offset + 0.28);
        tone.connect(level).connect(context.destination);
        tone.start(start + offset);
        tone.stop(start + offset + 0.3);
      });
    }
    function hangUp() {
      closed = true;
      if (peer) peer.close();
      stopMicrophone();
      if (context) { context.onstatechange = null; context.close(); }
    }
    </script></body></html>
    """
}
