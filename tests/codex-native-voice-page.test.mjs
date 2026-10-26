import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

const source=readFileSync(new URL('../apps/apple/Sources/DexterAppCore/CodexNativeVoicePage.swift',import.meta.url),'utf8');
const script=source.match(/<script>([\s\S]*?)<\/script>/)[1];
function lab({heldCapture=false,heldPlayback=false}={}) {
  const state={stops:0,peers:0,peerCloses:0,contexts:0,contextCloses:0,disconnects:0,messages:[],gain:null};
  const track={stop(){state.stops++;}},stream={getTracks:()=>[track]};
  let resolveCapture,resolvePlayback;
  const audio={srcObject:null,play:()=>heldPlayback?new Promise(r=>resolvePlayback=r):Promise.resolve()};
  class AudioContext {
    state='running';sampleRate=20;currentTime=0;destination={};
    constructor(){state.contexts++;}
    resume(){return Promise.resolve();}
    close(){state.contextCloses++;return Promise.resolve();}
    createMediaStreamDestination(){return {stream:{getAudioTracks:()=>[{}]}};}
    createGain(){const gain={gain:{value:1},connect:x=>x};state.gain=gain;return gain;}
    createMediaStreamSource(){return {connect:x=>x,disconnect(){state.disconnects++;}};}
    createBuffer(){return {getChannelData:()=>new Float32Array(40)};}
    createBufferSource(){return {connect(){},start(){}};}
  }
  class RTCPeerConnection {
    connectionState='new';iceGatheringState='complete';localDescription=null;
    constructor(){state.peers++;}
    addTrack(){}createDataChannel(){}
    createOffer(){return Promise.resolve({type:'offer',sdp:'v=0\r\nsynthetic-offer'});}
    setLocalDescription(value){this.localDescription=value;return Promise.resolve();}
    setRemoteDescription(){this.connectionState='connected';this.ontrack({streams:[{}]});this.onconnectionstatechange();return Promise.resolve();}
    close(){state.peerCloses++;this.connectionState='closed';}
  }
  const context=vm.createContext({AudioContext,RTCPeerConnection,document:{getElementById:()=>audio},
    navigator:{mediaDevices:{getUserMedia:()=>heldCapture?new Promise(r=>resolveCapture=r):Promise.resolve(stream)}},
    window:{webkit:{messageHandlers:{dexterVoice:{postMessage:m=>state.messages.push(m)}}}},setTimeout});
  vm.runInContext(script,context);
  return {state,run:text=>vm.runInContext(text,context),releaseCapture:()=>resolveCapture(stream),releasePlayback:()=>resolvePlayback()};
}
test('permission resolution after hangup stops late tracks and never constructs a peer',async()=>{
  const qa=lab({heldCapture:true});const offered=qa.run('offer()');qa.run('hangUp()');qa.releaseCapture();
  assert.equal(await offered,null);assert.equal(qa.state.stops,1);assert.equal(qa.state.peers,0);assert.equal(qa.state.contexts,0);
});
test('hangup between capture and attachment rejects the completed stream',async()=>{
  const qa=lab();const captured=await qa.run('capture(true)');qa.run('hangUp()');
  qa.run('globalThis.testCaptured = null');
  // The returned object is only a synthetic stream; re-enter at the actual async attachment boundary.
  const attach=qa.run('(value)=>useMicrophone(value)');assert.equal(attach(captured),false);
  assert.equal(qa.state.stops,1);assert.equal(qa.state.contexts,0);
});
test('actual page requires playback and connection, mute sends no mic gain, hangup drains owned objects',async()=>{
  const qa=lab();qa.run('mute(true)');assert.match(await qa.run('offer()'),/^v=0/);
  assert.equal(qa.state.gain.gain.value,0);await qa.run('answer("v=0 synthetic-answer")');await Promise.resolve();
  assert.equal(qa.state.messages.filter(m=>m.connected).length,1);
  qa.run('mute(false)');assert.equal(qa.state.gain.gain.value,1);
  qa.run('hangUp()');assert.equal(qa.state.stops,1);assert.equal(qa.state.peerCloses,1);assert.equal(qa.state.contextCloses,1);
});
test('late playback after hangup cannot announce a live call',async()=>{
  const qa=lab({heldPlayback:true});await qa.run('offer()');await qa.run('answer("v=0 synthetic-answer")');
  qa.run('hangUp()');qa.releasePlayback();await Promise.resolve();await Promise.resolve();
  assert.equal(qa.state.messages.filter(m=>m.connected).length,0);assert.equal(qa.state.stops,1);
});
