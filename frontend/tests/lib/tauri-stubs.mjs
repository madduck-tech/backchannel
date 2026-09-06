// What component tests reach for, stubbed in one place so a test says what it depends on
// instead of hiding it in a config.
//
// `@tauri-apps/api/mocks` is already a dependency and its `mockIPC` would cover these, but
// the component imports `invoke` and `listen` directly, and these tests load it through
// transpile-and-run rather than a bundler, so the imports are supplied here by name. That
// also keeps the stub surface visible: if the component grows a fifth dependency, the test
// fails loudly instead of silently pulling in half the application.
export function tauriStubs({ devices = [], onInvoke = () => {}, extra = {} } = {}) {
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push({ cmd, args });
    onInvoke(cmd, args);
    switch (cmd) {
      case 'get_audio_devices': return devices;
      // BackendInfo[]; an empty list keeps AudioBackendSelector's `backends.length <= 1`
      // early return, so it renders nothing and contributes no selects of its own.
      case 'get_audio_backend_info': return [];
      case 'get_current_audio_backend': return null;
      case 'set_audio_backend': return null;
      // RecordingControls asks whether a recording is already running before it renders
      // anything (#66). `false` is the state its own tests set up with the `isRecording` prop.
      case 'is_recording': return false;
      default:
        if (Object.prototype.hasOwnProperty.call(extra, cmd)) {
          const value = extra[cmd];
          return typeof value === 'function' ? value(args) : value;
        }
        // Loud on purpose: a component that grows a dependency the test has not accounted for
        // must fail here rather than quietly pulling half the application into the run.
        throw new Error(`invoked an unstubbed command: ${cmd}`);
    }
  };
  // The component subscribes to 'audio-levels'; nothing here emits, and nothing renders it
  // (the meter is gated behind a button commented out upstream — see #15).
  const listen = async () => () => {};
  return { core: { invoke }, event: { listen }, calls };
}
