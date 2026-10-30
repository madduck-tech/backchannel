// The loopback run's independent capture (#291): channels 1-2 of a CoreAudio input, to a WAV.
//
//     record <device name or UID> <out.wav>      records until SIGTERM or SIGINT
//
// ffmpeg's avfoundation input was measured on #291 losing about 11 s in 100 s from BlackHole 16ch,
// with and without a filter, and the markers in what it kept did not line up. This records
// through AUHAL instead, and checks itself: every buffer's sample time must follow the
// last one's, and any gap is counted and printed with the frames written on exit, so a capture
// that drops audio says so instead of producing a shorter recording.
import AVFoundation
import CoreAudio
import Foundation

func fail(_ msg: String) -> Never {
  FileHandle.standardError.write("record: \(msg)\n".data(using: .utf8)!)
  exit(1)
}

func stringProperty(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
  var addr = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                                        mElement: kAudioObjectPropertyElementMain)
  var value: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr, let v = value else { return nil }
  return v.takeRetainedValue() as String
}

func inputChannels(_ id: AudioObjectID) -> Int {
  var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration,
                                        mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
  let list = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 16)
  defer { list.deallocate() }
  guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, list) == noErr else { return 0 }
  let abl = UnsafeMutableAudioBufferListPointer(list.assumingMemoryBound(to: AudioBufferList.self))
  return abl.reduce(0) { $0 + Int($1.mNumberChannels) }
}

func device(named want: String) -> AudioObjectID {
  var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal,
                                        mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size)
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids)
  let matches = ids.filter {
    inputChannels($0) > 0 &&
      (stringProperty($0, kAudioObjectPropertyName) == want || stringProperty($0, kAudioDevicePropertyDeviceUID) == want)
  }
  guard matches.count == 1 else { fail("\(matches.count) input devices named '\(want)'") }
  return matches[0]
}

let args = CommandLine.arguments
guard args.count == 3 else { fail("usage: record <device name or UID> <out.wav>") }
var dev = device(named: args[1])

// AUHAL with input only: AVAudioEngine also brings up the default output, and refused to start
// (-10868) when that output's rate (the soundcore, 44.1 kHz) differed from BlackHole 16ch's 48 kHz.
var desc = AudioComponentDescription(componentType: kAudioUnitType_Output, componentSubType: kAudioUnitSubType_HALOutput,
                                     componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0)
guard let comp = AudioComponentFindNext(nil, &desc) else { fail("no HAL output component") }
var auOpt: AudioUnit?
guard AudioComponentInstanceNew(comp, &auOpt) == noErr, let au = auOpt else { fail("cannot create AUHAL") }
var one: UInt32 = 1, zero: UInt32 = 0
let u32 = UInt32(MemoryLayout<UInt32>.size)
guard AudioUnitSetProperty(au, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &one, u32) == noErr,
      AudioUnitSetProperty(au, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &zero, u32) == noErr,
      AudioUnitSetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev,
                           UInt32(MemoryLayout<AudioObjectID>.size)) == noErr else { fail("cannot configure AUHAL for the device") }
var hw = AudioStreamBasicDescription()
var asbdSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
guard AudioUnitGetProperty(au, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 1, &hw, &asbdSize) == noErr else { fail("no device format") }
let deviceChannels = Int(hw.mChannelsPerFrame)
let rate = hw.mSampleRate
var client = AudioStreamBasicDescription(mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
                                         mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved,
                                         mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4,
                                         mChannelsPerFrame: UInt32(deviceChannels), mBitsPerChannel: 32, mReserved: 0)
guard AudioUnitSetProperty(au, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &client, asbdSize) == noErr else { fail("cannot set the client format") }
let keep = min(2, deviceChannels)
guard let outFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: AVAudioChannelCount(keep), interleaved: false) else { fail("no file format") }
let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: rate, AVNumberOfChannelsKey: keep,
                               AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false]
let file: AVAudioFile
do {
  file = try AVAudioFile(forWriting: URL(fileURLWithPath: args[2]), settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
} catch { fail("cannot write \(args[2]): \(error)") }

final class State {
  let lock = NSLock()
  var pending: [[Float]]
  var written: Int64 = 0
  var gaps = 0
  var gapFrames: Int64 = 0
  var expected: Double? = nil
  let maxFrames = 8192
  var unit: AudioUnit? = nil
  let abl: UnsafeMutableAudioBufferListPointer
  init(channels: Int, keep: Int) {
    pending = Array(repeating: [], count: keep)
    abl = AudioBufferList.allocate(maximumBuffers: channels)
    for i in 0..<channels {
      abl[i] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(maxFrames * 4),
                           mData: UnsafeMutableRawPointer.allocate(byteCount: maxFrames * 4, alignment: 16))
    }
  }
}
let state = State(channels: deviceChannels, keep: keep)
state.unit = au
let statePtr = Unmanaged.passRetained(state).toOpaque()

var callback = AURenderCallbackStruct(inputProc: { ref, flags, ts, bus, frames, _ in
  let st = Unmanaged<State>.fromOpaque(ref).takeUnretainedValue()
  let n = Int(frames)
  guard n <= st.maxFrames else { st.lock.lock(); st.gaps += 1; st.lock.unlock(); return noErr }
  for i in 0..<st.abl.count { st.abl[i].mDataByteSize = UInt32(n * 4) }
  let status = AudioUnitRender(st.unit!, flags, ts, bus, frames, st.abl.unsafeMutablePointer)
  st.lock.lock(); defer { st.lock.unlock() }
  if status != noErr { st.gaps += 1; return noErr }
  let t = ts.pointee.mSampleTime
  if let e = st.expected, abs(t - e) > 0.5 { st.gaps += 1; st.gapFrames += Int64(t - e) }
  st.expected = t + Double(n)
  for c in 0..<st.pending.count {
    let p = st.abl[c].mData!.assumingMemoryBound(to: Float.self)
    st.pending[c].append(contentsOf: UnsafeBufferPointer(start: p, count: n))
  }
  return noErr
}, inputProcRefCon: statePtr)
guard AudioUnitSetProperty(au, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0, &callback,
                           UInt32(MemoryLayout<AURenderCallbackStruct>.size)) == noErr else { fail("cannot set the input callback") }

func drain() {
  state.lock.lock()
  let chunk = state.pending
  for c in 0..<state.pending.count { state.pending[c].removeAll(keepingCapacity: true) }
  state.lock.unlock()
  let n = chunk.first?.count ?? 0
  guard n > 0, let buf = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: AVAudioFrameCount(n)), let dst = buf.floatChannelData else { return }
  buf.frameLength = AVAudioFrameCount(n)
  for c in 0..<chunk.count { chunk[c].withUnsafeBufferPointer { dst[c].update(from: $0.baseAddress!, count: n) } }
  do { try file.write(from: buf); state.written += Int64(n) } catch { state.gaps += 1 }
}

func finish() {
  AudioOutputUnitStop(au)
  drain()
  print("{\"frames\": \(state.written), \"rate\": \(rate), \"device_channels\": \(deviceChannels), \"gaps\": \(state.gaps), \"gap_frames\": \(state.gapFrames)}")
  exit(state.gaps == 0 ? 0 : 3)
}
let timer = DispatchSource.makeTimerSource(queue: .main)
timer.schedule(deadline: .now() + 0.5, repeating: 0.5)
timer.setEventHandler(handler: drain)
timer.resume()
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
term.setEventHandler(handler: finish)
term.resume()
let intr = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
intr.setEventHandler(handler: finish)
intr.resume()
guard AudioUnitInitialize(au) == noErr, AudioOutputUnitStart(au) == noErr else { fail("cannot start the input") }
dispatchMain()
