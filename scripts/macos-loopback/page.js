// The loopback peer (#291): side A captures the requested input and sends it over one
// RTCPeerConnection; side B receives it over another, in this same page, plays it to the requested
// output and records what it received. Side A's capture is recorded before it is sent.
//
// Nothing here chooses a device by itself: labels are resolved by the server (runcheck.resolve)
// before any input is opened, so a missing, ambiguous or default label never opens a microphone.
// What was applied is reported, not what was asked; the launcher's void rules compare the two.
// No STUN: host candidates only, both ends on this Mac.

const state = (s) => { document.getElementById('state').textContent = s; };
const post = (path, body, type = 'application/json') =>
  fetch(path, { method: 'POST', headers: { 'Content-Type': type }, body });
const event = (e) => post('/event', JSON.stringify({ t: (performance.timeOrigin + performance.now()) / 1000, ...e }));
const PINNED_BPS = 32000;

async function main() {
  const params = await (await fetch('/params.json')).json();
  const test = params.test || {};
  const record = { requested: { sample_rate: test.requested_rate || params.rate }, applied: {}, ice: {}, stats: { bytes: [] } };

  // P6a's red variant: open the default input with no constraint, hold it, close it.
  if (test.unconstrained) {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    await new Promise((r) => setTimeout(r, 3500));
    s.getTracks().forEach((t) => t.stop());
    await event({ type: 'unconstrained-done' });
  }

  const devices = (await navigator.mediaDevices.enumerateDevices())
    .map((d) => ({ kind: d.kind, deviceId: d.deviceId, groupId: d.groupId, label: d.label }));
  const resolved = await (await post('/devices', JSON.stringify(devices))).json();
  record.requested.input_device_id = resolved.input_device_id ?? null;
  record.requested.output_device_id = resolved.output_device_id ?? null;
  if (resolved.void) {
    await post('/record', JSON.stringify({ ...record, void_before_capture: resolved.void }));
    await event({ type: 'done', void: resolved.void });
    state('void: ' + resolved.void);
    return;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: resolved.input_device_id },
      echoCancellation: !!test.echo, noiseSuppression: false, autoGainControl: false,
      channelCount: 1, sampleRate: params.rate,
    },
  });
  const track = stream.getAudioTracks()[0];
  const settings = track.getSettings();
  record.applied.input = {
    deviceId: settings.deviceId, label: track.label, sampleRate: settings.sampleRate,
    echoCancellation: settings.echoCancellation, noiseSuppression: settings.noiseSuppression,
    autoGainControl: settings.autoGainControl, channelCount: settings.channelCount,
  };

  const ctx = new AudioContext({ sampleRate: 48000, sinkId: { type: 'none' } });
  await ctx.audioWorklet.addModule('/worklet.js');
  if (test.suspend) await ctx.suspend(); else await ctx.resume();
  record.applied.contextState = ctx.state;
  record.applied.contextSampleRate = ctx.sampleRate;

  const a = new RTCPeerConnection({ iceServers: [] });
  const b = new RTCPeerConnection({ iceServers: [] });
  if (!test.block_ice) {
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  }
  const sender = a.addTrack(track, stream);
  const remote = new Promise((r) => { b.ontrack = (e) => r(e.streams[0] || new MediaStream([e.track])); });

  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  const answer = await b.createAnswer();
  // The receiver's fmtp caps what the sender may send; pinned to the offline chain's 32 kbit/s.
  answer.sdp = answer.sdp.replace(/a=fmtp:(\d+) (.*useinbandfec=1.*)/, (m, pt, rest) =>
    `a=fmtp:${pt} ${rest.replace(/;?maxaveragebitrate=\d+/, '')};maxaveragebitrate=${PINNED_BPS}`);
  await b.setLocalDescription(answer);
  await a.setRemoteDescription(b.localDescription);
  const p = sender.getParameters();
  p.encodings = (p.encodings && p.encodings.length ? p.encodings : [{}]).map((e) => ({ ...e, maxBitrate: PINNED_BPS }));
  await sender.setParameters(p);

  const connected = await Promise.race([
    new Promise((r) => { const f = () => a.connectionState === 'connected' && r(true); a.onconnectionstatechange = f; f(); }),
    new Promise((r) => setTimeout(() => r(false), 15000)),
  ]);
  record.ice.connectionState = a.connectionState;
  if (!connected) {
    await post('/record', JSON.stringify(record));
    await event({ type: 'done', void: `connection ${a.connectionState}` });
    state('connection ' + a.connectionState);
    return;
  }

  const received = await remote;
  // Played through a media element: a remote stream fed only to Web Audio can stay silent in Chrome.
  const audio = document.getElementById('side-b');
  audio.srcObject = received;
  await audio.setSinkId(resolved.output_device_id);
  await audio.play();
  record.applied.sinkId = audio.sinkId;

  const tap = (src, name) => {
    const node = new AudioWorkletNode(ctx, 'tap');
    let pending = [];
    let size = 0;
    node.port.onmessage = (m) => {
      pending.push(m.data); size += m.data.length;
      if (size >= 48000) {
        const buf = new Float32Array(size); let o = 0;
        for (const c of pending) { buf.set(c, o); o += c.length; }
        pending = []; size = 0;
        post('/chunk/' + name, buf.buffer, 'application/octet-stream');
      }
    };
    src.connect(node);
    return node;
  };
  tap(ctx.createMediaStreamSource(stream), 'pre_send');
  tap(ctx.createMediaStreamSource(received), 'side_b');
  await event({ type: 'tap-start' });

  const pollStats = async () => {
    const report = await a.getStats();
    let out = null; let pair = null; const cands = {}; const codecs = {};
    report.forEach((r) => {
      if (r.type === 'outbound-rtp' && r.kind === 'audio') out = r;
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
      if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands[r.id] = r;
      if (r.type === 'codec') codecs[r.id] = r;
    });
    const t = (performance.timeOrigin + performance.now()) / 1000;
    if (out) {
      record.stats.bytes.push({ t, bytesSent: out.bytesSent, targetBitrate: out.targetBitrate ?? null });
      const c = codecs[out.codecId];
      if (c) record.stats.codec = { mimeType: c.mimeType, clockRate: c.clockRate, channels: c.channels, sdpFmtpLine: c.sdpFmtpLine };
    }
    if (pair) {
      const l = cands[pair.localCandidateId]; const r = cands[pair.remoteCandidateId];
      record.ice.selectedPair = {
        local: l && { address: l.address, port: l.port, candidateType: l.candidateType, protocol: l.protocol },
        remote: r && { address: r.address, port: r.port, candidateType: r.candidateType, protocol: r.protocol },
      };
    }
    record.ice.connectionState = a.connectionState;
  };
  await pollStats();
  const statsTimer = setInterval(pollStats, 1000);

  state('recording');
  await event({ type: 'ready', contextState: ctx.state });
  await new Promise((r) => setTimeout(r, params.seconds * 1000));
  clearInterval(statsTimer);
  await pollStats();
  record.applied.contextState = ctx.state === 'running' ? record.applied.contextState : ctx.state;
  await new Promise((r) => setTimeout(r, 1500)); // let the last chunks post
  await post('/record', JSON.stringify(record));
  await event({ type: 'done' });
  state('done');
}

main().catch(async (e) => {
  state('error: ' + e);
  await event({ type: 'done', error: String(e && (e.stack || e)) });
});
