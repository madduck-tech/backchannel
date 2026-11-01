// CoreAudio facts for the census (#316): devices with their UIDs, the defaults, named UIDs
// resolved even when hidden, and which processes hold which devices for input.
//
//     coreaudio devices                 every device in kAudioHardwarePropertyDevices: uid, name, in, out
//     coreaudio defaults                the default input, output and system output, by UID
//     coreaudio resolve <uid> ...       each UID translated to a device, hidden ones included
//     coreaudio process-inputs          every HAL process object: pid and its input-scope device UIDs
//
// One JSON document on stdout. A property that cannot be read is reported with its OSStatus, never
// as an empty value.
import CoreAudio
import Foundation

func prop<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, _ value: inout T) -> OSStatus {
  var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
  var size = UInt32(MemoryLayout<T>.size)
  return AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &value)
}

func string(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
  var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var v: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &v) == noErr, let s = v else { return nil }
  return s.takeRetainedValue() as String
}

func ids(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> [AudioObjectID] {
  var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(obj, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
  var out = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &out) == noErr else { return [] }
  return out
}

func channels(_ dev: AudioObjectID, _ scope: AudioObjectPropertyScope) -> Int {
  var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: scope, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(dev, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
  let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 16)
  defer { raw.deallocate() }
  guard AudioObjectGetPropertyData(dev, &addr, 0, nil, &size, raw) == noErr else { return 0 }
  return UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self)).reduce(0) { $0 + Int($1.mNumberChannels) }
}

let sys = AudioObjectID(kAudioObjectSystemObject)
func uid(_ d: AudioObjectID) -> String? { string(d, kAudioDevicePropertyDeviceUID) }

func emit(_ v: Any) {
  let data = try! JSONSerialization.data(withJSONObject: v, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
}

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "devices":
  emit(ids(sys, kAudioHardwarePropertyDevices).map { d -> [String: Any] in
    ["uid": uid(d).map { $0 as Any } ?? NSNull(), "name": string(d, kAudioObjectPropertyName).map { $0 as Any } ?? NSNull(),
     "in": channels(d, kAudioDevicePropertyScopeInput), "out": channels(d, kAudioDevicePropertyScopeOutput)]
  })
case "defaults":
  var out: [String: Any] = [:]
  for (k, sel) in [("input", kAudioHardwarePropertyDefaultInputDevice), ("output", kAudioHardwarePropertyDefaultOutputDevice),
                   ("system_output", kAudioHardwarePropertyDefaultSystemOutputDevice)] {
    var d = AudioObjectID(0)
    let st = prop(sys, sel, kAudioObjectPropertyScopeGlobal, &d)
    let v: Any = st != noErr ? "OSStatus \(st)" : (uid(d).map { $0 as Any } ?? NSNull())
    out[k] = v
  }
  emit(out)
case "resolve":
  var out: [String: Any] = [:]
  for u in args.dropFirst(2) {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyTranslateUIDToDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var cf = u as CFString
    var d = AudioObjectID(0)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let st = withUnsafeMutablePointer(to: &cf) { p in
      AudioObjectGetPropertyData(sys, &addr, UInt32(MemoryLayout<CFString>.size), p, &size, &d)
    }
    var hidden = UInt32(0)
    _ = prop(d, kAudioDevicePropertyIsHidden, kAudioObjectPropertyScopeGlobal, &hidden)
    let found: [String: Any] = ["id": d, "name": string(d, kAudioObjectPropertyName).map { $0 as Any } ?? NSNull(), "hidden": hidden != 0]
    let v: Any = st != noErr ? "OSStatus \(st)" : (d == kAudioObjectUnknown ? NSNull() as Any : found as Any)
    out[u] = v
  }
  emit(out)
case "process-inputs":
  emit(ids(sys, kAudioHardwarePropertyProcessObjectList).map { p -> [String: Any] in
    var pid = pid_t(0)
    _ = prop(p, kAudioProcessPropertyPID, kAudioObjectPropertyScopeGlobal, &pid)
    let inputs = ids(p, kAudioProcessPropertyDevices, kAudioObjectPropertyScopeInput).map { uid($0) ?? "\($0)" }
    return ["pid": pid, "input_devices": inputs]
  })
default:
  FileHandle.standardError.write("usage: coreaudio devices|defaults|resolve <uid>...|process-inputs\n".data(using: .utf8)!)
  exit(64)
}
