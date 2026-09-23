(() => {
  // Qt for WebAssembly removes many browser/DOM prototype methods after bootstrap. Keep callable
  // references for the state and stacking updates that must continue while a game is running.
  const applyBrowserFunction = window.Reflect.apply;
  const domSetAttribute = window.Element.prototype.setAttribute;
  const domStyleSetProperty = window.CSSStyleDeclaration.prototype.setProperty;
  const storageGetItem = window.Storage.prototype.getItem;
  const storageSetItem = window.Storage.prototype.setItem;
  const storageRemoveItem = window.Storage.prototype.removeItem;
  const setDomAttribute = (element, name, value) =>
    applyBrowserFunction(domSetAttribute, element, [name, value]);
  const setDomStyle = (element, name, value, priority = "") =>
    applyBrowserFunction(domStyleSetProperty, element.style, [name, value, priority]);
  const wrapBrowserStorage = (storage) => ({
    getItem: (key) => applyBrowserFunction(storageGetItem, storage, [key]),
    setItem: (key, value) => applyBrowserFunction(storageSetItem, storage, [key, value]),
    removeItem: (key) => applyBrowserFunction(storageRemoveItem, storage, [key]),
  });
  const browserLocalStorage = wrapBrowserStorage(window.localStorage);
  const browserSessionStorage = wrapBrowserStorage(window.sessionStorage);
  const BrowserAudioContext = window.AudioContext || window.webkitAudioContext;
  const BrowserAudioWorkletNode = window.AudioWorkletNode;
  const BrowserBlob = window.Blob;
  const browserCreateObjectURL = window.URL.createObjectURL.bind(window.URL);
  const browserRevokeObjectURL = window.URL.revokeObjectURL.bind(window.URL);
  const browserSetInterval = window.setInterval.bind(window);
  const BrowserTextEncoder = window.TextEncoder;
  const browserFetch = window.fetch.bind(window);
  const browserPrompt = window.prompt.bind(window);
  const browserAlert = window.alert.bind(window);

  const USER_PATH = "/dolphin/user";
  const SETTINGS_STORAGE_KEY = "dolphin-wasm-user-config-v3";
  const OLD_SETTINGS_STORAGE_KEYS = [
    "dolphin-wasm-user-config-v1",
    "dolphin-wasm-user-config-v2",
  ];
  const TAB_GAME_STORAGE_KEY = "dolphin-wasm-tab-games-v1";

  let persistentBrowserAudio = null;
  const installBrowserAudio = (Module = null) => {
    if (persistentBrowserAudio) {
      if (Module)
        persistentBrowserAudio.setModule(Module);
      return persistentBrowserAudio;
    }

    if (!BrowserAudioContext) {
      console.warn("Dolphin WASM WebAudio is unavailable in this browser.");
      return null;
    }

    const context = new BrowserAudioContext({latencyHint: "interactive", sampleRate: 48000});
    let wasmModule = Module;
    let ring = null;
    let workletNode = null;
    let workletBuffer = null;
    let audioUnlocked = false;

    const workletSource = `
      class DolphinAudioProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.ring = null;
          this.heap16 = null;
          this.heap32 = null;
          this.framesReported = 0;
          this.port.onmessage = (event) => {
            const data = event.data;
            if (!data || data.type !== "ring")
              return;
            if (!data.buffer) {
              this.ring = null;
              this.heap16 = null;
              this.heap32 = null;
              return;
            }
            this.ring = data;
            this.heap16 = new Int16Array(data.buffer);
            this.heap32 = new Int32Array(data.buffer);
          };
        }

        process(inputs, outputs) {
          const output = outputs[0];
          const left = output && output[0];
          const right = output && (output[1] || output[0]);
          if (!left || !right)
            return true;
          left.fill(0);
          if (right !== left)
            right.fill(0);

          const ring = this.ring;
          const heap16 = this.heap16;
          const heap32 = this.heap32;
          if (!ring || !heap16 || !heap32 || Atomics.load(heap32, ring.runningPtr >> 2) === 0)
            return true;

          let read = Atomics.load(heap32, ring.readPtr >> 2) >>> 0;
          const write = Atomics.load(heap32, ring.writePtr >> 2) >>> 0;
          const available = (write - read) & ring.mask;
          const frames = Math.min(left.length, available);
          const volume = Math.min(1, Math.max(0, Atomics.load(heap32, ring.volumePtr >> 2) / 100));
          const sampleBase = ring.samplesPtr >> 1;
          for (let i = 0; i < frames; ++i) {
            const sampleFrame = (read + i) & ring.mask;
            left[i] = heap16[sampleBase + sampleFrame * 2] / 32768 * volume;
            right[i] = heap16[sampleBase + sampleFrame * 2 + 1] / 32768 * volume;
          }
          Atomics.store(heap32, ring.readPtr >> 2, (read + frames) & ring.mask);
          this.framesReported += frames;
          if (this.framesReported >= sampleRate) {
            this.port.postMessage({type: "frames", count: this.framesReported, available});
            this.framesReported = 0;
          }
          return true;
        }
      }
      registerProcessor("dolphin-output", DolphinAudioProcessor);
    `;

    let workletReady;
    if (context.audioWorklet && BrowserAudioWorkletNode && BrowserBlob) {
      const workletUrl = browserCreateObjectURL(new BrowserBlob([workletSource],
          {type: "text/javascript"}));
      workletReady = context.audioWorklet.addModule(workletUrl).then(() => {
        browserRevokeObjectURL(workletUrl);
        workletNode = new BrowserAudioWorkletNode(context, "dolphin-output", {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        workletNode.port.onmessage = (event) => {
          if (event.data?.type !== "frames")
            return;
          setDomAttribute(document.documentElement, "data-dolphin-audio-frames",
              String(event.data.count));
          setDomAttribute(document.documentElement, "data-dolphin-audio-buffered",
              String(event.data.available));
        };
        workletNode.connect(context.destination);
        setDomAttribute(document.documentElement, "data-dolphin-audio-engine", "worklet");
      }).catch((error) => {
        browserRevokeObjectURL(workletUrl);
        setDomAttribute(document.documentElement, "data-dolphin-audio-engine", "failed");
        console.error(`Dolphin WASM AudioWorklet setup failed: ${error}`);
      });
    } else {
      workletReady = Promise.resolve();
      setDomAttribute(document.documentElement, "data-dolphin-audio-engine", "unsupported");
      console.error("Dolphin WASM AudioWorklet is unavailable in this browser.");
    }

    // Prefer the live WebAssembly.Memory: with ALLOW_MEMORY_GROWTH the heap view objects are
    // replaced after growth, and Qt's modularized runtime only exposes them when exported.
    const currentHeapBuffer = () => wasmModule?.wasmMemory?.buffer || wasmModule?.HEAP16?.buffer || null;
    const sendRingToWorklet = () => {
      const buffer = currentHeapBuffer();
      if (!ring || !workletNode || !buffer)
        return;
      workletBuffer = buffer;
      workletNode.port.postMessage({type: "ring", buffer: workletBuffer, ...ring});
      setDomAttribute(document.documentElement, "data-dolphin-audio-bridge", "attached");
    };
    workletReady.then(sendRingToWorklet);
    browserSetInterval(() => {
      if (ring && workletNode && currentHeapBuffer() !== workletBuffer)
        sendRingToWorklet();
    }, 250);

    const updateAudioState = () => {
      setDomAttribute(document.documentElement, "data-dolphin-audio", context.state);
    };
    const resume = (event = null) => {
      // Chrome only allows resume() in the synchronous call stack of a trusted user gesture.
      // Timer retries generate autoplay warnings and can never unlock the context.
      if (event && !event.isTrusted)
        return Promise.resolve(false);
      if (event)
        audioUnlocked = true;
      if (!audioUnlocked || (context.state !== "suspended" && context.state !== "interrupted")) {
        updateAudioState();
        return Promise.resolve(context.state === "running");
      }
      return context.resume().then(() => {
        updateAudioState();
        if (context.state === "running")
          console.log("Dolphin WASM audio unlocked by user gesture.");
        return context.state === "running";
      }).catch((error) => {
        updateAudioState();
        console.warn(`Dolphin WASM audio resume failed: ${error}`);
        return false;
      });
    };
    const userActivationEvents = ["pointerdown", "mousedown", "touchstart", "keydown", "click"];
    for (const eventName of userActivationEvents)
      window.addEventListener(eventName, resume, {capture: true, passive: true});
    context.addEventListener?.("statechange", updateAudioState);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && audioUnlocked)
        resume();
    });

    persistentBrowserAudio = {
      setModule(nextModule) {
        wasmModule = nextModule;
      },
      attach(samplesPtr, capacityFrames, writePtr, readPtr, runningPtr, volumePtr) {
        if (!wasmModule || capacityFrames <= 0 || (capacityFrames & (capacityFrames - 1)) !== 0)
          return 0;
        ring = {
          samplesPtr, capacityFrames, mask: capacityFrames - 1,
          writePtr, readPtr, runningPtr, volumePtr,
        };
        workletReady.then(sendRingToWorklet);
        if (audioUnlocked)
          resume();
        setDomAttribute(document.documentElement, "data-dolphin-audio", context.state);
        return Math.round(context.sampleRate || 48000);
      },
      detach() {
        ring = null;
        workletBuffer = null;
        workletNode?.port.postMessage({type: "ring", buffer: null});
        setDomAttribute(document.documentElement, "data-dolphin-audio-bridge", "detached");
      },
    };
    document.documentElement.DolphinBrowserAudio = persistentBrowserAudio;
    setDomAttribute(document.documentElement, "data-dolphin-audio", context.state);
    return persistentBrowserAudio;
  };

  const queryFlag = (name, defaultValue = false) => {
    const value = new URLSearchParams(window.location.search).get(name);
    if (value === null)
      return defaultValue;
    return value === "1" || value === "true" || value === "on";
  };

  const isDebugLoggingRequested = () => queryFlag("debuglog");

  const isWasmJitRequested = () => {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("wasmjit");
    return value === "1" || value === "true" || value === "on";
  };

  const selectedVideoBackend = () => {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("webgpu") || params.get("softwarewebgpu");
    const requested = value === "1" || value === "true" || value === "on";
    if (requested && window.navigator?.gpu)
      return "WebGPU";
    if (requested)
      console.warn("Dolphin WASM WebGPU was requested, but navigator.gpu is unavailable; " +
                   "using hardware WebGL2/OGL instead.");
    return "OGL";
  };

  const isSettingsResetRequested = () => {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("resetsettings") || params.get("resetuser") || params.get("clearsettings");
    return value === "1" || value === "true" || value === "on";
  };

  const isFullscreenRequested = () => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("windowed") === "1" || params.get("windowed") === "true" ||
        params.get("windowed") === "on") {
      return false;
    }
    // Games open maximized by default; ?fullscreen=0 or ?windowed=1 opts out.
    const value = params.get("fullscreen");
    return !(value === "0" || value === "false" || value === "off");
  };

  const applyFullscreenAttribute = () => {
    setDomAttribute(document.body, "data-dolphin-fullscreen", isFullscreenRequested() ? "1" : "0");
  };

  const queryGamePath = () => {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("exec") || params.get("game") || params.get("rom");
    return raw ? raw.trim() : "";
  };

  const requestJsonSync = (url) => {
    const request = new XMLHttpRequest();
    request.open("GET", url, false);
    request.send(null);
    if (request.status !== 200)
      throw new Error(`${request.status}: ${url}`);
    return JSON.parse(request.responseText || "{}");
  };

  const requestBytesSync = (url) => {
    const payload = requestJsonSync(url);
    if (!payload.ok || typeof payload.data !== "string")
      throw new Error(payload.error || `Invalid binary response: ${url}`);
    return base64ToBytes(payload.data);
  };

  const ensureDirectory = (FS, path) => {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      try {
        if (!FS.analyzePath(current).exists)
          FS.mkdir(current);
      } catch (e) {
      }
    }
  };

  const sanitizeName = (name, fallback) => {
    const cleaned = (name || fallback || "game.rvz")
      .replace(/[\\/:*?<>|]/g, "_")
      .replaceAll(String.fromCharCode(34), "_");
    return cleaned || fallback || "game.rvz";
  };

  const safeSessionStorage = () => {
    try {
      const testKey = "__dolphin_wasm_test";
      browserSessionStorage.setItem(testKey, "1");
      browserSessionStorage.removeItem(testKey);
      return browserSessionStorage;
    } catch (e) {
      return null;
    }
  };

  const saveTabGameMount = (files, mountPoint) => {
    const storage = safeSessionStorage();
    if (!storage || !files.length)
      return;

    try {
      storage.setItem(TAB_GAME_STORAGE_KEY, JSON.stringify({
        mountPoint,
        savedAt: Date.now(),
        files: files.map((file) => ({
          hostPath: String(file.hostPath || ""),
          name: sanitizeName(file.name, "game.rvz"),
          relativePath: String(file.relativePath || file.name || "game.rvz"),
          size: Number(file.size || 0),
        })).filter((file) => file.hostPath && file.size > 0),
      }));
      console.log(`Dolphin WASM tab game cache saved: ${files.length} file(s).`);
    } catch (error) {
      console.warn(`Dolphin WASM tab game cache save failed: ${error}`);
    }
  };

  const readTabGameMount = () => {
    const storage = safeSessionStorage();
    if (!storage)
      return null;

    try {
      const snapshot = JSON.parse(storage.getItem(TAB_GAME_STORAGE_KEY) || "{}");
      const files = Array.isArray(snapshot.files) ? snapshot.files.filter((file) =>
        file && file.hostPath && Number(file.size) > 0) : [];
      if (!files.length)
        return null;
      return {
        mountPoint: snapshot.mountPoint || "/dolphin/game-directory",
        files,
      };
    } catch (error) {
      console.warn(`Dolphin WASM tab game cache restore failed: ${error}`);
      return null;
    }
  };

  const bytesToBase64 = (bytes) => {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  };

  const base64ToBytes = (data) => {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; ++i)
      bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  const dirname = (path) => {
    const index = path.lastIndexOf("/");
    return index <= 0 ? "/" : path.slice(0, index);
  };

  const setIniValue = (text, section, key, value) => {
    const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
    let sectionStart = -1;
    let sectionEnd = lines.length;
    for (let i = 0; i < lines.length; ++i) {
      const match = lines[i].match(/^\s*\[([^\]]+)\]\s*$/);
      if (!match)
        continue;
      if (match[1] === section) {
        sectionStart = i;
      } else if (sectionStart !== -1) {
        sectionEnd = i;
        break;
      }
    }

    if (sectionStart === -1) {
      if (lines.length && lines[lines.length - 1] !== "")
        lines.push("");
      lines.push(`[${section}]`, `${key} = ${value}`);
      return lines.join("\n");
    }

    const keyRegex = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);
    for (let i = sectionStart + 1; i < sectionEnd; ++i) {
      if (keyRegex.test(lines[i])) {
        lines[i] = `${key} = ${value}`;
        return lines.join("\n");
      }
    }

    lines.splice(sectionEnd, 0, `${key} = ${value}`);
    return lines.join("\n");
  };

  const hasIniValue = (text, section, key) => {
    const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
    let inSection = false;
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const keyRegex = new RegExp(`^\\s*${escapedKey}\\s*=`);
    for (const line of lines) {
      const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (sectionMatch) {
        inSection = sectionMatch[1] === section;
        continue;
      }
      if (inSection && keyRegex.test(line))
        return true;
    }
    return false;
  };

  const setIniDefault = (text, section, key, value) =>
    hasIniValue(text, section, key) ? text : setIniValue(text, section, key, value);

  const getIniValue = (text, section, key) => {
    const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
    let inSection = false;
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const keyRegex = new RegExp(`^\\s*${escapedKey}\\s*=\\s*(.*?)\\s*$`);
    for (const line of lines) {
      const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (sectionMatch) {
        inSection = sectionMatch[1] === section;
        continue;
      }
      if (!inSection)
        continue;
      const match = line.match(keyRegex);
      if (match)
        return match[1];
    }
    return "";
  };

  const ensureGameListConfig = (Module, mountPoint) => {
    const FS = Module.FS;
    ensureDirectory(FS, `${USER_PATH}/Config`);
    const iniPath = `${USER_PATH}/Config/Dolphin.ini`;
    let iniText = "";
    try {
      if (FS.analyzePath(iniPath).exists)
        iniText = new TextDecoder().decode(FS.readFile(iniPath));
    } catch (e) {
    }

    iniText = setIniValue(iniText, "General", "ISOPaths", "1");
    iniText = setIniValue(iniText, "General", "ISOPath0", mountPoint);
    iniText = setIniValue(iniText, "General", "RecursiveISOPaths", "True");
    FS.writeFile(iniPath, new TextEncoder().encode(iniText));
  };

  const injectPerformanceConfig = (Module) => {
    const FS = Module.FS;
    ensureDirectory(FS, `${USER_PATH}/Config`);
    const iniPath = `${USER_PATH}/Config/Dolphin.ini`;
    let iniText = "";
    try {
      if (FS.analyzePath(iniPath).exists)
        iniText = new TextDecoder().decode(FS.readFile(iniPath));
    } catch (e) {
    }

    const videoBackend = selectedVideoBackend();
    const values = [
      ["Core", "CPUThread", "True"],
      ["Core", "DSPHLE", "True"],
      ["Core", "SIDevice0", "6"],
      ["Core", "GPUDeterminismMode", "none"],
      ["Core", "GFXBackend", videoBackend],
      ["Core", "FastDiscSpeed", "True"],
      ["Core", "SyncOnSkipIdle", "False"],
      ["Core", "AccurateCPUCache", "False"],
      ["Core", "OverclockEnable", "False"],
      ["Display", "Fullscreen", "False"],
      ["Display", "RenderToMain", "True"],
      ["Display", "RenderWindowAutoSize", "False"],
      ["Display", "RenderWindowWidth", "640"],
      ["Display", "RenderWindowHeight", "480"],
      ["DSP", "DSPThread", "True"],
      ["DSP", "DSPHLE", "True"],
      ["DSP", "Backend", "WebAudio"],
      ["DSP", "Volume", "100"],
    ];
    // The WASM JIT (CPUCore 6, "Jiterpreter") is the default browser CPU core. ?wasmjit=1 forces
    // it and ?wasmjit=0 forces the Cached Interpreter (5), e.g. to compare speed or bisect a bug.
    const wasmJitParam = new URLSearchParams(window.location.search).get("wasmjit");
    if (isWasmJitRequested())
      iniText = setIniValue(iniText, "Core", "CPUCore", "6");
    else if (wasmJitParam === "0" || wasmJitParam === "false" || wasmJitParam === "off")
      iniText = setIniValue(iniText, "Core", "CPUCore", "5");
    else
      iniText = setIniDefault(iniText, "Core", "CPUCore", "6");
    // These are browser defaults, not policy. Never overwrite a value the user changed and saved.
    for (const [section, key, value] of values)
      iniText = setIniDefault(iniText, section, key, value);

    FS.writeFile(iniPath, new TextEncoder().encode(iniText));

    // Always connect Wii Remote 1 to Dolphin's emulated input device. This file is
    // persisted separately from WiimoteNew.ini and an old desktop/browser setting
    // can otherwise leave the correctly mapped controller disconnected in-game.
    const wiimoteSourcePath = `${USER_PATH}/Config/Wiimote.ini`;
    let wiimoteSourceText = "";
    try {
      if (FS.analyzePath(wiimoteSourcePath).exists)
        wiimoteSourceText = new TextDecoder().decode(FS.readFile(wiimoteSourcePath));
    } catch (e) {
    }
    wiimoteSourceText = setIniDefault(wiimoteSourceText, "Wiimote1", "Source", "1");
    wiimoteSourceText = setIniDefault(wiimoteSourceText, "Wiimote2", "Source", "0");
    wiimoteSourceText = setIniDefault(wiimoteSourceText, "Wiimote3", "Source", "0");
    wiimoteSourceText = setIniDefault(wiimoteSourceText, "Wiimote4", "Source", "0");
    FS.writeFile(wiimoteSourcePath, new TextEncoder().encode(wiimoteSourceText));

    // Emscripten's proxied WebGL context cannot be initialized from Dolphin's auxiliary
    // shader compiler pthreads. A zero-thread compiler still compiles real GX shaders,
    // synchronously on the render thread, and avoids deadlocking startup.
    const gfxIniPath = `${USER_PATH}/Config/GFX.ini`;
    let gfxIniText = "";
    try {
      if (FS.analyzePath(gfxIniPath).exists)
        gfxIniText = new TextDecoder().decode(FS.readFile(gfxIniPath));
    } catch (e) {
    }
    gfxIniText = setIniDefault(gfxIniText, "Settings", "ShaderCompilationMode", "0");
    gfxIniText = setIniDefault(gfxIniText, "Settings", "ShaderCache", "True");
    gfxIniText = setIniDefault(gfxIniText, "Settings", "ShaderCompilerThreads", "0");
    gfxIniText = setIniDefault(gfxIniText, "Settings", "ShaderPrecompilerThreads", "0");
    gfxIniText = setIniDefault(gfxIniText, "Settings", "WaitForShadersBeforeStarting", "False");
    gfxIniText = setIniDefault(gfxIniText, "Hardware", "VSync", "False");
    gfxIniText = setIniDefault(gfxIniText, "Settings", "InternalResolution", "1");
    // Fill the whole game canvas (AspectMode::Stretch) instead of letterboxing inside it.
    gfxIniText = setIniDefault(gfxIniText, "Settings", "AspectRatio", "3");
    gfxIniText = setIniDefault(gfxIniText, "Settings", "MSAA", "1");
    gfxIniText = setIniDefault(gfxIniText, "Settings", "SSAA", "False");
    gfxIniText = setIniDefault(gfxIniText, "Settings", "HiresTextures", "False");
    gfxIniText = setIniDefault(gfxIniText, "Settings", "CacheHiresTextures", "False");
    gfxIniText = setIniDefault(gfxIniText, "Settings", "SafeTextureCacheColorSamples", "0");
    gfxIniText = setIniDefault(gfxIniText, "Settings", "EnableValidationLayer", "False");
    // Browser GL commands are expensive even with an OffscreenCanvas. Rejecting invisible GX
    // triangles before submission reduces both command traffic and fragment work.
    gfxIniText = setIniDefault(gfxIniText, "Settings", "CPUCull", "True");
    gfxIniText = setIniDefault(gfxIniText, "Settings", "SaveTextureCacheToState", "False");
    // 20->30fps browser tuning: kill per-pixel CPU readbacks and extra shader variants.
    gfxIniText = setIniDefault(gfxIniText, "Hacks", "EFBAccessEnable", "False");
    gfxIniText = setIniDefault(gfxIniText, "Hacks", "BBoxEnable", "False");
    gfxIniText = setIniDefault(gfxIniText, "Hacks", "EFBEmulateFormatChanges", "False");
    gfxIniText = setIniDefault(gfxIniText, "Enhancements", "MaxAnisotropy", "0");
    gfxIniText = setIniDefault(gfxIniText, "Enhancements", "ForceTextureFiltering", "0");
    gfxIniText = setIniDefault(gfxIniText, "Enhancements", "ArbitraryMipmapDetection", "False");
    gfxIniText = setIniDefault(gfxIniText, "Hacks", "EFBToTextureEnable", "True");
    gfxIniText = setIniDefault(gfxIniText, "Hacks", "XFBToTextureEnable", "True");
    gfxIniText = setIniDefault(gfxIniText, "Hacks", "DeferEFBCopies", "True");
    gfxIniText = setIniDefault(gfxIniText, "Hacks", "SkipDuplicateXFBs", "True");
    gfxIniText = setIniDefault(gfxIniText, "Hacks", "FastTextureSampling", "True");
    FS.writeFile(gfxIniPath, new TextEncoder().encode(gfxIniText));

    const configuredBackend = getIniValue(iniText, "Core", "GFXBackend") || videoBackend;
    const rendererDescription = configuredBackend === "OGL" ? "hardware WebGL2/OGL" :
        configuredBackend === "WebGPU" ? "experimental WebGPU presenter with software GX rasterization" :
        configuredBackend;
    console.log(`Dolphin WASM performance INI injected: dual-core, threaded DSP HLE, ` +
                `${rendererDescription}.`);
    if (configuredBackend === "WebGPU") {
      console.warn("This branch's WebGPU GX backend is software-rasterized. Remove webgpu=1 to " +
                   "use the hardware WebGL2/OGL speed path.");
    }

    const loggerPath = `${USER_PATH}/Config/Logger.ini`;
    let loggerText = "";
    const debugLogging = isDebugLoggingRequested();
    const loggerValues = [
      ["Options", "WriteToConsole", debugLogging ? "True" : "False"],
      ["Options", "WriteToFile", "False"],
      ["Options", "WriteToWindow", "False"],
      ["Options", "Verbosity", debugLogging ? "4" : "1"],
      ["Logs", "BOOT", "False"],
      ["Logs", "CORE", "False"],
      ["Logs", "DIO", "False"],
      ["Logs", "DVD", "False"],
      ["Logs", "PowerPC", "False"],
      ["Logs", "Video", "False"],
      ["Logs", "Host GPU", "False"],
      ["Logs", "IOS", "False"],
      ["Logs", "IOS_DI", "False"],
      ["Logs", "IOS_WIIMOTE", debugLogging ? "True" : "False"],
      ["Logs", "ControllerInterface", debugLogging ? "True" : "False"],
      ["Logs", "HLE", debugLogging ? "True" : "False"],
    ];
    for (const [section, key, value] of loggerValues)
      loggerText = setIniValue(loggerText, section, key, value);
    FS.writeFile(loggerPath, new TextEncoder().encode(loggerText));
  };

  const ensureBrowserControllerConfig = (Module) => {
    const FS = Module.FS;
    ensureDirectory(FS, `${USER_PATH}/Config`);

    const readText = (path) => FS.analyzePath(path).exists ? FS.readFile(path, {encoding: "utf8"}) : "";
    const sectionBody = (text, section) => {
      const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return text.match(new RegExp(`(?:^|\\n)\\[${escaped}\\]\\r?\\n([\\s\\S]*?)(?=\\n\\[|$)`))?.[1] || "";
    };
    const hasBindings = (text, section) => sectionBody(text, section).split(/\r?\n/).some((line) => {
      const match = line.match(/^\s*([^#;][^=]*?)\s*=\s*(.*?)\s*$/);
      if (!match || !match[2])
        return false;
      const key = match[1].trim();
      const value = match[2].trim();
      if (["Device", "Source"].includes(key))
        return false;
      if (value.includes("`"))
        return true;
      // Preserve hand-written expressions, while ignoring ordinary numeric/bool/options settings.
      return key.includes("/") &&
          !/^(?:true|false|none|-?\d+(?:\.\d+)?(?:\s+-?\d+(?:\.\d+)?)*?)$/i.test(value);
    });
    const writeText = (path, text) => {
      FS.writeFile(path, new BrowserTextEncoder().encode(text));
    };

    const wiimotePath = `${USER_PATH}/Config/WiimoteNew.ini`;
    // Only repair devices that cannot exist in the browser (empty or desktop backends such as
    // DInput/XInput). A Browser/* device the user picked in the mapping dialog must survive reloads.
    const ensureBrowserDevice = (text, section) =>
      /^Browser\//.test(getIniValue(text, section, "Device") || "") ? text :
        setIniValue(text, section, "Device", "Browser/0/Gamepad");

    let wiimoteText = readText(wiimotePath);
    for (let slot = 1; slot <= 4; ++slot) {
      wiimoteText = ensureBrowserDevice(wiimoteText, `Wiimote${slot}`);
      wiimoteText = setIniDefault(wiimoteText, `Wiimote${slot}`, "Source", slot === 1 ? "1" : "0");
    }
    wiimoteText = ensureBrowserDevice(wiimoteText, "BalanceBoard");
    wiimoteText = setIniDefault(wiimoteText, "BalanceBoard", "Source", "0");

    let migratedWiimote = false;
    if (!hasBindings(wiimoteText, "Wiimote1")) {
      // Gamepad first, keyboard alternates second so a browser without a detected pad still
      // gets a playable Wii Remote (X/Z = A/B, 1/2, Q/E = -/+, Backspace = Home, arrows = D-Pad).
      const kb = (name) => "`Browser/0/Keyboard:" + name + "`";
      const bindings = {
        "Buttons/A": "`Button 0` | " + kb("X"), "Buttons/B": "`Button 1` | " + kb("Z"),
        "Buttons/1": "`Button 2` | " + kb("1"), "Buttons/2": "`Button 3` | " + kb("2"),
        "Buttons/-": "`Button 8` | " + kb("Q"), "Buttons/+": "`Button 9` | " + kb("E"),
        "Buttons/Home": "`Button 16` | " + kb("Backspace"),
        "D-Pad/Up": "`Button 12` | " + kb("ArrowUp"), "D-Pad/Down": "`Button 13` | " + kb("ArrowDown"),
        "D-Pad/Left": "`Button 14` | " + kb("ArrowLeft"), "D-Pad/Right": "`Button 15` | " + kb("ArrowRight"),
        "Shake/X": "`Button 5` | " + kb("Space"), "Shake/Y": "`Button 5` | " + kb("Space"),
        "Shake/Z": "`Button 5` | " + kb("Space"),
        "Point/Up": "`Right Y-`", "Point/Down": "`Right Y+`",
        "Point/Left": "`Right X-`", "Point/Right": "`Right X+`",
        "Point/Relative Input": "True",
        "Tilt/Forward": "`Left Y-`", "Tilt/Backward": "`Left Y+`",
        "Tilt/Left": "`Left X-`", "Tilt/Right": "`Left X+`",
        "Swing/Up": "`Button 12`", "Swing/Down": "`Button 13`",
        "Swing/Left": "`Button 14`", "Swing/Right": "`Button 15`",
        "Swing/Forward": "`Button 7`", "Swing/Backward": "`Button 6`",
        "Hotkeys/Sideways Toggle": "`Button 4`",
        "Extension": "None",
      };
      for (const [key, value] of Object.entries(bindings))
        wiimoteText = setIniValue(wiimoteText, "Wiimote1", key, value);
      migratedWiimote = true;
    }

    const gcPadPath = `${USER_PATH}/Config/GCPadNew.ini`;
    let gcPadText = readText(gcPadPath);
    for (let slot = 1; slot <= 4; ++slot)
      gcPadText = ensureBrowserDevice(gcPadText, `GCPad${slot}`);

    let migratedGCPad = false;
    if (!hasBindings(gcPadText, "GCPad1")) {
      // Gamepad (standard Web Gamepad layout: 4/5 = LB/RB, 6/7 = LT/RT) with the desktop Dolphin
      // keyboard layout as alternates: X/Z/C/S/D = A/B/X/Y/Z, Enter = Start, arrows = main stick,
      // I/J/K/L = C-stick, T/F/G/H = D-Pad, Q/W = L/R.
      const kb = (name) => "`Browser/0/Keyboard:" + name + "`";
      const bindings = {
        "Buttons/A": "`Button 0` | " + kb("X"), "Buttons/B": "`Button 1` | " + kb("Z"),
        "Buttons/X": "`Button 2` | " + kb("C"), "Buttons/Y": "`Button 3` | " + kb("S"),
        "Buttons/Z": "`Button 5` | " + kb("D"), "Buttons/Start": "`Button 9` | " + kb("Enter"),
        "Main Stick/Up": "`Left Y-` | " + kb("ArrowUp"), "Main Stick/Down": "`Left Y+` | " + kb("ArrowDown"),
        "Main Stick/Left": "`Left X-` | " + kb("ArrowLeft"), "Main Stick/Right": "`Left X+` | " + kb("ArrowRight"),
        "Main Stick/Calibration": "100.00",
        "C-Stick/Up": "`Right Y-` | " + kb("I"), "C-Stick/Down": "`Right Y+` | " + kb("K"),
        "C-Stick/Left": "`Right X-` | " + kb("J"), "C-Stick/Right": "`Right X+` | " + kb("L"),
        "C-Stick/Calibration": "100.00",
        "Triggers/L": "`Button 6` | " + kb("Q"), "Triggers/R": "`Button 7` | " + kb("W"),
        "Triggers/L-Analog": "`Button 6` | " + kb("Q"), "Triggers/R-Analog": "`Button 7` | " + kb("W"),
        "D-Pad/Up": "`Button 12` | " + kb("T"), "D-Pad/Down": "`Button 13` | " + kb("G"),
        "D-Pad/Left": "`Button 14` | " + kb("F"), "D-Pad/Right": "`Button 15` | " + kb("H"),
      };
      for (const [key, value] of Object.entries(bindings))
        gcPadText = setIniValue(gcPadText, "GCPad1", key, value);
      migratedGCPad = true;
    }

    writeText(wiimotePath, wiimoteText);
    writeText(gcPadPath, gcPadText);
    if (migratedWiimote || migratedGCPad)
      console.log("Dolphin WASM installed editable browser controller defaults.");
  };

  // The OGL backend renders on a video worker whose OffscreenCanvas is never presented by the
  // browser (the worker never yields to its event loop). Native Swap() transfers each finished
  // frame here as an ImageBitmap; draw it on a visible canvas stacked over the inert placeholder.
  let frameCanvas = null;
  let frameContext = null;
  const presentGameFrame = (bitmap) => {
    if (!frameContext) {
      frameCanvas = document.getElementById("dolphin-frame-canvas") ||
        document.createElement("canvas");
      frameCanvas.id = "dolphin-frame-canvas";
      if (!frameCanvas.isConnected)
        document.body.appendChild(frameCanvas);
      frameContext = frameCanvas.getContext("bitmaprenderer");
    }
    if (frameCanvas.width !== bitmap.width || frameCanvas.height !== bitmap.height) {
      frameCanvas.width = bitmap.width;
      frameCanvas.height = bitmap.height;
    }
    frameContext.transferFromImageBitmap(bitmap);
    if (document.body.dataset.dolphinFramePresenter !== "1")
      setDomAttribute(document.body, "data-dolphin-frame-presenter", "1");
  };
  window.DolphinPresentFrame = presentGameFrame;

  const installHeadlessViewport = () => {
    if (window.DolphinHeadlessViewportInstalled)
      return;
    window.DolphinHeadlessViewportInstalled = true;

    // Dolphin's Emscripten GLContext targets #canvas. Create it on the browser
    // thread before the GPU pthread attempts to create/proxy a WebGL2 context.
    let canvas = document.getElementById("canvas");
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.id = "canvas";
      canvas.tabIndex = 0;
      // Dolphin's Qt render window starts at the Wii EFB presentation size. Keep the
      // WebGL drawing buffer in lockstep with that 640x480 viewport; CSS below performs
      // the console's anamorphic widescreen stretch to the browser's 16:9 viewport.
      canvas.width = 640;
      canvas.height = 480;
      document.body.appendChild(canvas);
    }
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "Dolphin game canvas");
    canvas.addEventListener("pointerdown", () => canvas.focus({preventScroll: true}));

    // Qt/WebGL and WebGPU cannot acquire different context types from the same
    // HTML canvas. Keep Qt on #canvas and reserve this overlay for Dolphin's
    // native Emdawnwebgpu surface. It stays hidden for the working OGL backend.
    let webgpuCanvas = document.getElementById("dolphin-webgpu-canvas");
    if (!webgpuCanvas) {
      webgpuCanvas = document.createElement("canvas");
      webgpuCanvas.id = "dolphin-webgpu-canvas";
      // Keep the renderer at Dolphin's native presentation size. CSS scales this into the
      // centered game window; allocating a desktop-sized high-DPI swapchain wastes GPU time.
      webgpuCanvas.width = 640;
      webgpuCanvas.height = 480;
      document.body.appendChild(webgpuCanvas);
    }
    // Keep the overlay out of the way until the native WebGPU context confirms a successful
    // presentation. Otherwise a pending/failed adapter covers Qt's working fallback with black.
    webgpuCanvas.hidden = true;

    applyFullscreenAttribute();
    window.DolphinWasmToggleFullscreen = () => {
      const next = document.body.dataset.dolphinFullscreen !== "1" ? "1" : "0";
      setDomAttribute(document.body, "data-dolphin-fullscreen", next);
      return next === "1";
    };
    window.addEventListener("keydown", (event) => {
      if (event.key === "F11") {
        event.preventDefault();
        window.DolphinWasmToggleFullscreen();
      }
    }, true);

    const style = document.createElement("style");
    style.textContent = `
      html, body { width: 100%; height: 100%; margin: 0; background: #000; overflow: hidden; }
      #qtspinner { display: none !important; }
      #canvas {
        position: fixed !important;
        inset: auto !important;
        left: 50% !important;
        top: calc(50% + 48px) !important;
        display: block !important;
        width: min(960px, calc(100vw - 32px), calc((100vh - 144px) * 16 / 9)) !important;
        height: min(540px, calc(100vh - 144px), calc((100vw - 32px) * 9 / 16)) !important;
        aspect-ratio: 16 / 9 !important;
        margin: 0 !important;
        transform: translate(-50%, -50%) !important;
        background: #000 !important;
        visibility: hidden !important;
        z-index: -1 !important;
        pointer-events: none !important;
      }
      body[data-dolphin-game-running="1"] #canvas {
        visibility: visible !important;
        z-index: 3 !important;
        pointer-events: auto !important;
      }
      body[data-dolphin-game-running="1"][data-dolphin-fullscreen="1"] #canvas {
        inset: 0 !important;
        left: 0 !important;
        top: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        max-width: none !important;
        max-height: none !important;
        aspect-ratio: auto !important;
        transform: none !important;
      }
      #dolphin-webgpu-canvas {
        position: fixed;
        inset: auto;
        left: 50%;
        top: calc(50% + 48px);
        width: min(960px, calc(100vw - 32px), calc((100vh - 144px) * 16 / 9));
        height: min(540px, calc(100vh - 144px), calc((100vw - 32px) * 9 / 16));
        aspect-ratio: 16 / 9;
        transform: translate(-50%, -50%);
        z-index: 2;
        pointer-events: none;
        background: #000;
        visibility: hidden;
      }
      body[data-dolphin-game-running="1"] #dolphin-webgpu-canvas:not([hidden]) {
        z-index: 3;
        visibility: visible;
      }
      body[data-dolphin-game-running="1"][data-dolphin-fullscreen="1"] #dolphin-webgpu-canvas:not([hidden]) {
        inset: 0;
        left: 0;
        top: 0;
        width: 100vw;
        height: 100vh;
        max-width: none;
        max-height: none;
        aspect-ratio: auto;
        transform: none;
        z-index: 3;
        visibility: visible;
      }
      #dolphin-frame-canvas {
        position: fixed;
        left: 50%;
        top: calc(50% + 48px);
        width: min(960px, calc(100vw - 32px), calc((100vh - 144px) * 16 / 9));
        height: min(540px, calc(100vh - 144px), calc((100vw - 32px) * 9 / 16));
        transform: translate(-50%, -50%);
        z-index: 2;
        pointer-events: none;
        background: #000;
        visibility: hidden;
      }
      body[data-dolphin-game-running="1"][data-dolphin-frame-presenter="1"] #dolphin-frame-canvas {
        z-index: 4;
        visibility: visible;
      }
      body[data-dolphin-game-running="1"][data-dolphin-frame-presenter="1"][data-dolphin-fullscreen="1"] #dolphin-frame-canvas {
        left: 0;
        top: 0;
        width: 100vw;
        height: 100vh;
        transform: none;
      }
      body[data-dolphin-frame-presenter="1"] #dolphin-webgpu-canvas {
        visibility: hidden !important;
      }
      #dolphin-software-fallback-canvas {
        position: fixed;
        left: 50%;
        top: calc(50% + 48px);
        width: min(960px, calc(100vw - 32px), calc((100vh - 144px) * 16 / 9));
        height: min(540px, calc(100vh - 144px), calc((100vw - 32px) * 9 / 16));
        transform: translate(-50%, -50%);
        z-index: 2;
        pointer-events: none;
        visibility: hidden;
      }
      body[data-dolphin-game-running="1"] #dolphin-software-fallback-canvas:not([hidden]) {
        z-index: 3;
        visibility: visible;
      }
      body[data-dolphin-game-running="1"][data-dolphin-fullscreen="1"] #dolphin-software-fallback-canvas:not([hidden]) {
        inset: 0;
        left: 0;
        top: 0;
        width: 100vw;
        height: 100vh;
        transform: none;
      }
      #screen {
        position: fixed !important;
        inset: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        margin: 0 !important;
        background: #000 !important;
        z-index: 1 !important;
      }
      body[data-dolphin-dialog-open="1"] #screen {
        z-index: 5 !important;
      }
      body[data-dolphin-dialog-open="1"] #canvas,
      body[data-dolphin-dialog-open="1"] #dolphin-webgpu-canvas {
        pointer-events: none !important;
      }
    `;
    document.head.appendChild(style);

    // Every launch recreates the render placeholder. Drop the frame presenter until the new
    // session's OGL worker delivers a frame, so a WebGPU session is never covered by it.
    new MutationObserver((mutations) => {
      const relaunched = mutations.some((mutation) => Array.from(mutation.addedNodes)
        .some((node) => node.id === "dolphin-webgpu-canvas"));
      if (relaunched && document.body.dataset.dolphinFramePresenter === "1")
        document.body.removeAttribute("data-dolphin-frame-presenter");
    }).observe(document.body, {childList: true});

    // Maximize the game canvas without invoking the browser Fullscreen API.
  };

  const shouldPersistUserPath = (path) =>
    (path.startsWith(`${USER_PATH}/Config/`) && /\.(ini|json|txt)$/i.test(path)) ||
    path === `${USER_PATH}/Wii/shared2/sys/SYSCONF`;

  const mountPersistentUser = (Module) => {
    if (Module.DolphinPersistentUserMounted)
      return;

    const FS = Module.FS;
    ensureDirectory(FS, "/dolphin");
    ensureDirectory(FS, USER_PATH);

    let syncPending = false;
    const syncUserData = () => {
      if (syncPending)
        return;
      syncPending = true;
      try {
        const entries = {};
        const pending = [
          `${USER_PATH}/Config`,
          `${USER_PATH}/Wii/shared2/sys/SYSCONF`,
        ];
        while (pending.length) {
          const path = pending.pop();
          if (!FS.analyzePath(path).exists)
            continue;

          const stat = FS.stat(path);
          if (FS.isDir(stat.mode)) {
            for (const name of FS.readdir(path)) {
              if (name !== "." && name !== "..")
                pending.push(`${path}/${name}`);
            }
          } else if (FS.isFile(stat.mode) && shouldPersistUserPath(path)) {
            entries[path] = bytesToBase64(FS.readFile(path));
          }
        }
        browserLocalStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ entries }));
        setDomAttribute(document.documentElement, "data-dolphin-settings-cache", "saved");
      } catch (error) {
        console.warn(`Dolphin WASM settings cache save failed: ${error}`);
      } finally {
        syncPending = false;
      }
    };

    if (isSettingsResetRequested()) {
      browserLocalStorage.removeItem(SETTINGS_STORAGE_KEY);
      for (const key of OLD_SETTINGS_STORAGE_KEYS)
        browserLocalStorage.removeItem(key);
      console.log("Dolphin WASM settings cache cleared.");
    } else {
      for (const key of OLD_SETTINGS_STORAGE_KEYS)
        browserLocalStorage.removeItem(key);
      try {
        const cachedSettings = browserLocalStorage.getItem(SETTINGS_STORAGE_KEY);
        const snapshot = JSON.parse(cachedSettings || "{}");
        for (const [path, data] of Object.entries(snapshot.entries || {})) {
          if (!shouldPersistUserPath(path))
            continue;
          ensureDirectory(FS, dirname(path));
          FS.writeFile(path, base64ToBytes(data));
        }
        if (cachedSettings)
          setDomAttribute(document.documentElement, "data-dolphin-settings-cache", "restored");
        console.log("Dolphin WASM settings cache restored from browser storage.");
      } catch (error) {
        console.warn(`Dolphin WASM settings cache restore failed: ${error}`);
      }
    }

    // Native Qt writes the INI files in MEMFS. Mirror them quickly so refreshes cannot lose a
    // just-changed setting, and expose an explicit flush for the Qt settings dialog.
    Module.DolphinSyncUserData = syncUserData;
    document.documentElement.DolphinSyncUserData = syncUserData;
    window.DolphinWasmSyncUserData = syncUserData;
    window.addEventListener("pagehide", syncUserData);
    window.addEventListener("beforeunload", syncUserData);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden)
        syncUserData();
    });
    window.setInterval(syncUserData, 750);
    Module.DolphinPersistentUserMounted = true;
  };

  const seedDolphinNand = (Module) => {
    const FS = Module.FS;
    const sysconfPath = `${USER_PATH}/Wii/shared2/sys/SYSCONF`;
    if (FS.analyzePath(sysconfPath).exists && FS.stat(sysconfPath).size === 16384) {
      console.log("Dolphin WASM NAND SYSCONF restored from browser storage.");
      return;
    }

    try {
      const bytes = requestBytesSync("/__dolphin_user_sysconf");
      if (bytes.byteLength !== 16384)
        throw new Error(`Invalid Dolphin SYSCONF size: ${bytes.byteLength}`);
      ensureDirectory(FS, dirname(sysconfPath));
      FS.writeFile(sysconfPath, bytes);
      console.log("Dolphin WASM NAND seeded from the desktop Dolphin user folder.");
    } catch (error) {
      // A desktop NAND is optional. Dolphin will create browser-local defaults
      // for a fresh general-purpose installation.
      console.info(`Dolphin WASM starting with a fresh NAND: ${error}`);
    }
  };

  const createHostFS = (Module) => {
    if (Module.DolphinHostFS)
      return Module.DolphinHostFS;

    const FS = Module.FS;
    // Synchronous misses decode the block through a binary string (2 bytes per byte), so keep
    // blocks at 4 MiB to bound that transient; read-ahead makes most reads hits anyway.
    // Cache budget: 32 x 4 MiB = 128 MiB.
    const HOST_CACHE_BLOCK_SIZE = 4 * 1024 * 1024;
    const HOST_CACHE_MAX_BLOCKS = 32;
    // Loading screens stream the disc sequentially. Fetch the following blocks asynchronously so
    // the next synchronous read is a cache hit instead of a stall on an HTTP round trip.
    const HOST_READ_AHEAD_BLOCKS = 3;

    const hostBlockUrl = (contents, blockStart) => {
      const readLength = Math.min(HOST_CACHE_BLOCK_SIZE, contents.size - blockStart);
      return `/__dolphin_file_read?path=${encodeURIComponent(contents.hostPath)}` +
             `&offset=${blockStart}&length=${readLength}`;
    };

    const storeHostBlock = (contents, blockStart, bytes) => {
      contents.cache.set(blockStart, bytes);
      while (contents.cache.size > HOST_CACHE_MAX_BLOCKS) {
        const oldestKey = contents.cache.keys().next().value;
        contents.cache.delete(oldestKey);
      }
    };

    const prefetchHostBlocks = (contents, blockStart) => {
      if (!contents.inflight)
        contents.inflight = new Set();
      for (let i = 1; i <= HOST_READ_AHEAD_BLOCKS; ++i) {
        const next = blockStart + i * HOST_CACHE_BLOCK_SIZE;
        if (next >= contents.size || contents.cache.has(next) || contents.inflight.has(next))
          continue;
        contents.inflight.add(next);
        browserFetch(hostBlockUrl(contents, next))
          .then((response) => response.ok ? response.arrayBuffer() : null)
          .then((buffer) => {
            if (buffer && !contents.cache.has(next))
              storeHostBlock(contents, next, new Uint8Array(buffer));
          })
          .catch(() => {})
          .finally(() => contents.inflight.delete(next));
      }
    };

    const fetchHostBlock = (contents, blockStart) => {
      if (!contents.cache)
        contents.cache = new Map();

      const cached = contents.cache.get(blockStart);
      if (cached) {
        contents.cache.delete(blockStart);
        contents.cache.set(blockStart, cached);
        contents.cacheHits = (contents.cacheHits || 0) + 1;
        prefetchHostBlocks(contents, blockStart);
        return cached;
      }

      const url = hostBlockUrl(contents, blockStart);
      const request = new XMLHttpRequest();
      request.open("GET", url, false);
      try {
        request.responseType = "arraybuffer";
      } catch (e) {
        request.overrideMimeType("text/plain; charset=x-user-defined");
      }
      request.send(null);
      if (request.status !== 200)
        throw new FS.ErrnoError(5);

      let bytes;
      if (request.response instanceof ArrayBuffer) {
        bytes = new Uint8Array(request.response);
      } else {
        const text = request.responseText || "";
        bytes = new Uint8Array(text.length);
        for (let i = 0; i < text.length; ++i)
          bytes[i] = text.charCodeAt(i) & 0xff;
      }

      contents.cacheMisses = (contents.cacheMisses || 0) + 1;
      storeHostBlock(contents, blockStart, bytes);
      prefetchHostBlocks(contents, blockStart);

      if (contents.cacheMisses === 1 || contents.cacheMisses % 64 === 0) {
        console.log(`Dolphin WASM host cache: ${contents.cacheHits || 0} hits, ` +
                    `${contents.cacheMisses} misses, block=${HOST_CACHE_BLOCK_SIZE}`);
      }

      return bytes;
    };

    const HostFS = {
      DIR_MODE: 16895,
      FILE_MODE: 33279,
      mount(mount) {
        const root = HostFS.createNode(null, "/", HostFS.DIR_MODE, 0);
        for (const file of mount.opts.files || [])
          HostFS.addHostFileNode(root, file);
        return root;
      },
      pathParts(file) {
        const cleanPath = String(file.relativePath || file.name || "game.rvz").replace(/\\/g, "/");
        return cleanPath.split("/").filter(Boolean).map((part, index, parts) =>
          sanitizeName(part, index === parts.length - 1 ? file.name : "folder"));
      },
      addHostFileNode(root, file) {
        const parts = HostFS.pathParts(file);
        let parent = root;
        for (let i = 0; i < parts.length - 1; ++i) {
          const part = parts[i];
          if (!parent.contents[part])
            HostFS.createNode(parent, part, HostFS.DIR_MODE, 0, {});
          parent = parent.contents[part];
        }
        HostFS.createNode(parent, parts[parts.length - 1], HostFS.FILE_MODE, 0, file);
      },
      createNode(parent, name, mode, dev, contents) {
        const node = FS.createNode(parent, name, mode);
        node.mode = mode;
        node.node_ops = HostFS.node_ops;
        node.stream_ops = HostFS.stream_ops;
        node.atime = node.mtime = node.ctime = Date.now();
        node.size = mode === HostFS.FILE_MODE ? Number(contents.size) : 4096;
        node.contents = mode === HostFS.DIR_MODE ? {} : (contents || {});
        if (parent)
          parent.contents[name] = node;
        return node;
      },
      node_ops: {
        getattr(node) {
          return {
            dev: 1,
            ino: node.id,
            mode: node.mode,
            nlink: FS.isDir(node.mode) ? 2 : 1,
            uid: 0,
            gid: 0,
            rdev: 0,
            size: node.size,
            atime: new Date(node.atime),
            mtime: new Date(node.mtime),
            ctime: new Date(node.ctime),
            blksize: 4096,
            blocks: Math.ceil(node.size / 4096),
          };
        },
        setattr(node, attr) {
          for (const key of ["mode", "atime", "mtime", "ctime"]) {
            if (attr[key] != null)
              node[key] = attr[key];
          }
        },
        lookup(parent, name) {
          if (parent.contents && parent.contents[name])
            return parent.contents[name];
          throw new FS.ErrnoError(44);
        },
        mknod() { throw new FS.ErrnoError(63); },
        rename() { throw new FS.ErrnoError(63); },
        unlink() { throw new FS.ErrnoError(63); },
        rmdir() { throw new FS.ErrnoError(63); },
        readdir(node) { return [".", "..", ...Object.keys(node.contents || {})]; },
        symlink() { throw new FS.ErrnoError(63); },
      },
      stream_ops: {
        read(stream, buffer, offset, length, position) {
          if (FS.isDir(stream.node.mode))
            throw new FS.ErrnoError(31);
          if (position >= stream.node.size)
            return 0;

          const contents = stream.node.contents;
          const readLength = Math.min(length, stream.node.size - position);
          let bytesCopied = 0;
          while (bytesCopied < readLength) {
            const currentPosition = position + bytesCopied;
            const blockStart = Math.floor(currentPosition / HOST_CACHE_BLOCK_SIZE) *
                               HOST_CACHE_BLOCK_SIZE;
            const block = fetchHostBlock(contents, blockStart);
            const blockOffset = currentPosition - blockStart;
            const copyLength = Math.min(readLength - bytesCopied, block.length - blockOffset);
            if (copyLength <= 0)
              break;
            buffer.set(block.subarray(blockOffset, blockOffset + copyLength), offset + bytesCopied);
            bytesCopied += copyLength;
          }
          return bytesCopied;
        },
        write() { throw new FS.ErrnoError(29); },
        llseek(stream, offset, whence) {
          let position = offset;
          if (whence === 1)
            position += stream.position;
          else if (whence === 2 && FS.isFile(stream.node.mode))
            position += stream.node.size;
          if (position < 0)
            throw new FS.ErrnoError(28);
          return position;
        },
      },
      prefetch(path, maxBytes) {
        const node = FS.lookupPath(path, {follow: true}).node;
        if (!node || !FS.isFile(node.mode))
          throw new Error(`HostFS prefetch path is not a file: ${path}`);
        const limit = Math.min(Number(maxBytes) || 0, Number(node.size) || 0);
        for (let offset = 0; offset < limit; offset += HOST_CACHE_BLOCK_SIZE)
          fetchHostBlock(node.contents, offset);
        console.log(`Dolphin WASM prefetched ${Math.round(limit / 1024 / 1024)} MiB from ${path}.`);
      },
    };

    Module.DolphinHostFS = HostFS;
    return HostFS;
  };

  let persistentGameLibrary = null;
  const installBrowserGameLibrary = (Module = null) => {
    if (persistentGameLibrary) {
      if (Module)
        persistentGameLibrary.setModule(Module);
      return persistentGameLibrary;
    }

    let wasmModule = Module;
    const gameExtensions = new Set([
      ".elf", ".dol", ".gcm", ".bin", ".iso", ".tgc", ".wbfs", ".ciso", ".gcz", ".wia",
      ".rvz", ".nfs", ".wad", ".dff", ".m3u", ".json",
    ]);
    const isGameFile = (name) => {
      const clean = String(name || "").toLowerCase();
      return gameExtensions.has(clean.slice(clean.lastIndexOf(".")));
    };
    const resolveDroppedFiles = async (files) => {
      const resolved = [];
      for (const file of files.filter((candidate) => isGameFile(candidate.name))) {
        const guessResponse = await browserFetch(
          `/__dolphin_file_guess?name=${encodeURIComponent(file.name)}` +
          `&size=${encodeURIComponent(String(file.size))}`);
        const guess = guessResponse.ok ? await guessResponse.json() : {};
        let hostPath = guess.auto && guess.path ? guess.path : "";
        if (!hostPath) {
          const candidates = Array.isArray(guess.candidates) ? guess.candidates : [];
          const candidateText = candidates.length ?
            `\n\nMatches found:\n${candidates.map((candidate) => candidate.path).join("\n")}` : "";
          hostPath = browserPrompt(
            `Enter the full local path for ${file.name} so Dolphin can stream it.` + candidateText,
            guess.path || file.name) || "";
        }
        if (!hostPath)
          continue;

        const statResponse = await browserFetch(
          `/__dolphin_file_stat?path=${encodeURIComponent(hostPath)}`);
        const stat = statResponse.ok ? await statResponse.json() : null;
        if (!stat?.ok)
          throw new Error(stat?.error || `The local server cannot read ${hostPath}`);
        resolved.push({
          hostPath,
          name: sanitizeName(stat.name, file.name),
          relativePath: file.webkitRelativePath || file.name,
          size: Number(stat.size),
        });
      }
      return resolved;
    };
    const mountFiles = (files, startSingleGame = false) => {
      if (!wasmModule || !files.length)
        return "";
      const FS = wasmModule.FS;
      const mountPoint = "/dolphin/game-directory";
      const previous = readTabGameMount()?.files || [];
      const merged = [...previous, ...files].filter((file, index, all) =>
        all.findIndex((candidate) => candidate.hostPath === file.hostPath &&
          candidate.relativePath === file.relativePath) === index);

      ensureDirectory(FS, mountPoint);
      try {
        FS.unmount(mountPoint);
      } catch (e) {
      }
      FS.mount(createHostFS(wasmModule), {files: merged}, mountPoint);
      ensureGameListConfig(wasmModule, mountPoint);
      saveTabGameMount(merged, mountPoint);

      if (startSingleGame && files.length === 1) {
        const relativeParts = createHostFS(wasmModule).pathParts(files[0]);
        const mountedPath = `${mountPoint}/${relativeParts.join("/")}`;
        FS.writeFile("/dolphin/pending-drop-path.txt", new BrowserTextEncoder().encode(mountedPath));
        wasmModule._DolphinWasmHandleGameDrop?.();
      } else {
        wasmModule._DolphinWasmRefreshBrowserGameList?.();
      }
      return mountPoint;
    };

    persistentGameLibrary = {
      setModule(nextModule) {
        wasmModule = nextModule;
      },
      save(files, mountPoint = "/dolphin/game-directory") {
        saveTabGameMount(files, mountPoint);
      },
      restore() {
        const snapshot = readTabGameMount();
        return snapshot?.files?.length ? mountFiles(snapshot.files, false) : "";
      },
      mountFiles,
    };
    document.documentElement.DolphinBrowserGames = persistentGameLibrary;

    window.addEventListener("dragover", (event) => {
      if (!Array.from(event.dataTransfer?.items || []).some((item) => item.kind === "file"))
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.dataTransfer)
        event.dataTransfer.dropEffect = "copy";
    }, {capture: true});
    window.addEventListener("drop", (event) => {
      const files = Array.from(event.dataTransfer?.files || []);
      if (!files.length)
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setDomAttribute(document.documentElement, "data-dolphin-game-drop", "resolving");
      resolveDroppedFiles(files).then((resolved) => {
        if (!resolved.length)
          throw new Error("No supported GameCube or Wii game files were dropped");
        mountFiles(resolved, resolved.length === 1);
        setDomAttribute(document.documentElement, "data-dolphin-game-drop", "mounted");
      }).catch((error) => {
        setDomAttribute(document.documentElement, "data-dolphin-game-drop", "failed");
        console.error(`Dolphin WASM game drop failed: ${error}`);
        browserAlert(`Dolphin could not add that game: ${error.message || error}`);
      });
    }, {capture: true});
    return persistentGameLibrary;
  };

  const mountQueryGame = (Module, hostPath) => {
    if (!hostPath)
      return "";

    const FS = Module.FS;
    ensureDirectory(FS, "/dolphin/host");
    ensureDirectory(FS, USER_PATH);

    try {
      FS.unmount("/dolphin/host");
    } catch (e) {
    }

    const stat = requestJsonSync(`/__dolphin_file_stat?path=${encodeURIComponent(hostPath)}`);
    if (!stat.ok)
      throw new Error(stat.error || `Local file is not readable: ${hostPath}`);

    const name = sanitizeName(stat.name, "game.rvz");
    const files = [{ hostPath, name, relativePath: name, size: Number(stat.size) }];
    FS.mount(createHostFS(Module), { files }, "/dolphin/host");
    saveTabGameMount(files, "/dolphin/host");

    const mountedPath = `/dolphin/host/${name}`;
    console.log(`Dolphin WASM auto-mounted ${hostPath} as ${mountedPath}`);
    return mountedPath;
  };

  const mountTabGameDirectory = (Module) => {
    const snapshot = readTabGameMount();
    if (!snapshot)
      return "";

    const FS = Module.FS;
    // A previously opened single game should also return to the library after reload.
    const mountPoint = "/dolphin/game-directory";
    ensureDirectory(FS, "/dolphin");
    ensureDirectory(FS, USER_PATH);
    try {
      FS.unmount(mountPoint);
    } catch (e) {
    }
    try {
      if (!FS.analyzePath(mountPoint).exists)
        FS.mkdir(mountPoint);
    } catch (e) {
    }

    FS.mount(createHostFS(Module), { files: snapshot.files }, mountPoint);
    if (mountPoint === "/dolphin/game-directory")
      ensureGameListConfig(Module, mountPoint);
    console.log(`Dolphin WASM tab game cache restored: ${snapshot.files.length} file(s).`);
    return mountPoint;
  };

  const isFullscreenActive = () => {
    if (document.fullscreenElement)
      return true;

    const root = document.querySelector("#qt-shadow-container")?.shadowRoot;
    if (!root)
      return false;

    const windows = Array.from(root.querySelectorAll(".qt-decorated-window, .qt-window"));
    return windows.some((win) => {
      const title = win.querySelector?.(".window-name, .qt-window-title")?.textContent ||
        win.getAttribute?.("aria-label") || win.textContent || "";
      if (!/\[[\d.]+\s*FPS\]|Interpreter|WebGPU|HLE/i.test(title))
        return false;

      const rect = win.getBoundingClientRect();
      return rect.width >= window.innerWidth * 0.9 && rect.height >= window.innerHeight * 0.85;
    });
  };

  const exitBrowserFullscreen = () => {
    if (!document.fullscreenElement || !document.exitFullscreen)
      return false;

    document.exitFullscreen().catch((error) => {
      console.warn(`Dolphin WASM browser fullscreen exit failed: ${error}`);
    });
    return true;
  };

  const captureGameplayScreenshot = () => {
    if (isFullscreenActive()) {
      console.log("Dolphin WASM screenshot skipped while fullscreen.");
      return;
    }

    const root = document.querySelector("#qt-shadow-container")?.shadowRoot;
    const canvases = Array.from(root?.querySelectorAll("canvas") || document.querySelectorAll("canvas"));
    const canvas = canvases
      .filter((candidate) => candidate.width > 64 && candidate.height > 64)
      .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
    if (!canvas) {
      console.warn("Dolphin WASM screenshot failed: no gameplay canvas found.");
      return;
    }

    try {
      canvas.toBlob((blob) => {
        if (!blob) {
          console.warn("Dolphin WASM screenshot failed: canvas produced no image.");
          return;
        }
        const now = new Date();
        const stamp = now.toISOString().replace(/[:.]/g, "-");
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `dolphin-gameplay-${stamp}.png`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        console.log(`Dolphin WASM gameplay screenshot saved: ${link.download}`);
      }, "image/png");
    } catch (error) {
      console.warn(`Dolphin WASM screenshot failed: ${error}`);
    }
  };

  let persistentBrowserInput = null;
  const installBrowserInput = (Module = null) => {
    if (persistentBrowserInput) {
      if (Module) {
        persistentBrowserInput.setModule(Module);
        Module.DolphinBrowserInput = persistentBrowserInput;
        document.documentElement.dataset.dolphinInputModuleBridge = "ready";
      }
      return;
    }

    // Qt's WebAssembly bootstrap removes most Window globals once the application is running.
    // Keep bound references to the browser APIs that controller polling needs afterward.
    let inputModule = Module;
    const getBrowserGamepads = window.navigator?.getGamepads?.bind(window.navigator);
    const browserNow = window.performance?.now?.bind(window.performance) || (() => 0);
    const requestBrowserFrame = window.requestAnimationFrame?.bind(window) ||
      ((callback) => window.setTimeout(() => callback(browserNow()), 16));
    const BrowserKeyboardEvent = window.KeyboardEvent;

    // Must match the list in InputCommon/ControllerInterface/Emscripten/Emscripten.cpp (order and count).
    const keyboardCodeList =
      ("Enter|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|KeyW|KeyA|KeyS|KeyD|KeyZ|KeyX|" +
       "ShiftLeft|ControlLeft|KeyQ|KeyE|Digit1|Digit2|Escape|Backspace|" +
       "KeyC|KeyV|KeyF|KeyG|KeyR|KeyT|KeyI|KeyJ|KeyK|KeyL|KeyU|KeyO|KeyH|KeyN|KeyM|Tab|" +
       "Digit3|Digit4|ShiftRight|ControlRight").split("|");
    const pressedKeys = new Set();
    const latchedKeys = new Map();
    const gameplayCodes = new Set(keyboardCodeList);

    const isEditableTarget = (target) => {
      if (!target)
        return false;
      const tag = String(target.tagName || "").toLowerCase();
      return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
    };

    const updateKey = (event, pressed) => {
      if (!keyboardCodeList.includes(event.code))
        return;
      if (pressed) {
        pressedKeys.add(event.code);
        // Cached-interpreter startup can temporarily fall below 2 FPS, so a normal browser tap
        // must survive more than one host frame while the Wii Remote connects and polls input.
        latchedKeys.set(event.code, browserNow() + 1500);
      } else {
        pressedKeys.delete(event.code);
      }

      if (!isEditableTarget(event.target) && gameplayCodes.has(event.code))
        event.preventDefault();
    };

    window.addEventListener("keydown", (event) => updateKey(event, true), {capture: true});
    window.addEventListener("keyup", (event) => updateKey(event, false), {capture: true});
    window.addEventListener("blur", () => {
      pressedKeys.clear();
      latchedKeys.clear();
    });

    // Follow the Gamepad API model documented by MDN: connection events identify controllers by
    // Gamepad.index, but every animation frame must fetch a fresh Gamepad object from
    // navigator.getGamepads(). Do not retain an event's stale Gamepad object.
    const connectedGamepads = new Map();
    let activeGamepadIndex = null;
    let currentGamepad = null;
    let currentGamepadTimestamp = 0;
    const gamepadActivity = (pad) => {
      if (!pad?.connected)
        return 0;
      let activity = 0;
      for (const button of pad.buttons || [])
        activity = Math.max(activity, Number(button?.value) || (button?.pressed ? 1 : 0));
      for (const axis of pad.axes || [])
        activity = Math.max(activity, Math.abs(Number(axis) || 0));
      return activity;
    };
    const rememberGamepad = (pad) => {
      if (!pad?.connected)
        return;
      connectedGamepads.set(pad.index, {
        id: pad.id,
        index: pad.index,
        mapping: pad.mapping || "raw",
        buttons: pad.buttons.length,
        axes: pad.axes.length,
      });
    };
    const refreshGamepads = () => {
      const pads = getBrowserGamepads ? Array.from(getBrowserGamepads()) : [];
      const visible = pads.filter((pad) => pad?.connected);
      const visibleIndexes = new Set(visible.map((pad) => pad.index));
      for (const index of connectedGamepads.keys()) {
        if (!visibleIndexes.has(index))
          connectedGamepads.delete(index);
      }
      for (const pad of visible)
        rememberGamepad(pad);

      // A browser or Steam virtual controller can occupy index 0 while the physical pad is at a
      // later index. Switch to whichever controller is producing deliberate input, then keep that
      // stable index until another controller is actually used or it disconnects.
      const active = activeGamepadIndex == null ? null : pads[activeGamepadIndex];
      const used = visible
        .map((pad) => ({pad, activity: gamepadActivity(pad)}))
        .filter(({activity}) => activity >= 0.25)
        .sort((a, b) => b.activity - a.activity)[0]?.pad || null;
      if (used)
        activeGamepadIndex = used.index;
      else if (!active?.connected)
        activeGamepadIndex = (visible.find((pad) => pad.mapping === "standard") || visible[0])?.index ?? null;

      currentGamepad = activeGamepadIndex == null ? null : pads[activeGamepadIndex] || null;
      currentGamepadTimestamp = Number(currentGamepad?.timestamp) || currentGamepadTimestamp;
      setDomAttribute(document.documentElement, "data-dolphin-gamepad",
          currentGamepad ? "connected" : (getBrowserGamepads ? "waiting" : "unsupported"));
      setDomAttribute(document.documentElement, "data-dolphin-gamepad-index",
          currentGamepad ? String(currentGamepad.index) : "");
      return currentGamepad;
    };
    const getGamepad = () => currentGamepad || refreshGamepads();

    const buttonValue = (pad, index) => {
      const button = pad && index >= 0 && pad.buttons[index];
      return button ? Math.max(button.value || 0, button.pressed ? 1 : 0) : 0;
    };

    // Chromium exposes recognized XInput pads in the standard layout. Some Bluetooth/DInput
    // adapters expose the raw layout shown by Dolphin instead: -/+ are 6/7, analog L/R are 8/9,
    // HOME is 15, and the D-pad is a POV-hat axis. Translate that layout to Web Gamepad's
    // standard logical button numbers before Dolphin reads it.
    const rawButtonMap = [0, 1, 2, 3, 4, 5, 8, 9, 6, 7, 10, 11, -1, -1, -1, -1, 15];
    const rawHatValue = (pad, logicalButton) => {
      if (!pad || logicalButton < 12 || logicalButton > 15)
        return 0;

      // Prefer discrete D-pad buttons when the browser supplies them despite a raw mapping.
      const discrete = buttonValue(pad, logicalButton);
      if (discrete > 0)
        return discrete;

      const hatAxis = pad.axes.length > 9 ? pad.axes[9] : null;
      if (!Number.isFinite(hatAxis) || hatAxis > 1.01 || hatAxis < -1.01)
        return 0;

      const direction = Math.max(0, Math.min(7, Math.round((hatAxis + 1) * 3.5)));
      const activeDirections = {
        12: [0, 1, 7], // up
        13: [3, 4, 5], // down
        14: [5, 6, 7], // left
        15: [1, 2, 3], // right
      };
      return activeDirections[logicalButton].includes(direction) ? 1 : 0;
    };
    const logicalButtonValue = (pad, id) => {
      if (!pad)
        return 0;
      if (pad.mapping === "standard")
        return buttonValue(pad, id);
      if (id >= 12 && id <= 15)
        return rawHatValue(pad, id);
      return buttonValue(pad, rawButtonMap[id] ?? id);
    };

    // Keep very short browser button taps visible long enough for Dolphin's WASM input thread.
    // This is particularly important while the cached interpreter or WebGPU pipeline is warming up.
    const gamepadButtonLatches = new Map();
    let previousGamepadButtons = [];
    const updateGamepadButtonLatches = () => {
      const pad = getGamepad();
      const now = browserNow();
      const nextButtons = Array.from({length: 17}, (_, id) => logicalButtonValue(pad, id) > 0.5);
      nextButtons.forEach((pressed, id) => {
        if (pressed && !previousGamepadButtons[id])
          gamepadButtonLatches.set(id, now + 300);
      });
      previousGamepadButtons = nextButtons;
    };
    let menuNavigationSuppressed = false;
    let menuNavigationReady = false;
    let stateBufferPtr = 0;
    let stateBufferLength = 0;
    let nativeHeap32 = null;
    let nativeMemory = null;
    let nativeSnapshotSequence = 0;
    // The build links with ALLOW_MEMORY_GROWTH, so a cached Int32Array can point at a stale
    // buffer after the heap grows. Always derive the view from the live WebAssembly.Memory.
    const resolveHeap32 = () => {
      const memory = inputModule?.wasmMemory || nativeMemory;
      if (memory?.buffer) {
        if (!nativeHeap32 || nativeHeap32.buffer !== memory.buffer)
          nativeHeap32 = new Int32Array(memory.buffer);
        return nativeHeap32;
      }
      return inputModule?.HEAP32 || nativeHeap32;
    };
    const buttonStateCount = 17;
    const axisStateOffset = buttonStateCount;
    const keyboardStateOffset = axisStateOffset + 8;
    const stateScale = 32767;

    const browserInput = {
      setModule(nextModule) {
        inputModule = nextModule;
      },
      attachStateBuffer(pointer, length, heap32 = null, memory = null) {
        stateBufferPtr = Number(pointer) || 0;
        stateBufferLength = Number(length) || 0;
        nativeMemory = memory || nativeMemory;
        nativeHeap32 = heap32 || nativeHeap32;
        setDomAttribute(document.documentElement, "data-dolphin-input-buffer",
            stateBufferPtr && stateBufferLength ? "attached" : "detached");
      },
      keyboard(id) {
        const code = keyboardCodeList[id];
        const active = pressedKeys.has(code) || (latchedKeys.get(code) || 0) > browserNow();
        return active ? 1 : 0;
      },
      gamepadButton(id) {
        const pad = getGamepad();
        if (!pad)
          return 0;
        const value = Math.max(logicalButtonValue(pad, id),
            (gamepadButtonLatches.get(id) || 0) > browserNow() ? 1 : 0);
        return value;
      },
      gamepadAxis(axis, positive) {
        const pad = getGamepad();
        const value = pad && Number.isFinite(pad.axes[axis]) ? pad.axes[axis] : 0;
        const deadzone = 0.12;
        const magnitude = Math.abs(value);
        const filtered = magnitude <= deadzone ? 0 :
            Math.sign(value) * Math.min(1, (magnitude - deadzone) / (1 - deadzone));
        return Math.max(0, positive ? filtered : -filtered);
      },
      setMenuNavigationSuppressed(suppressed) {
        menuNavigationSuppressed = Boolean(suppressed);
        menuNavigationReady = false;
        if (menuNavigationSuppressed) {
          gamepadButtonLatches.clear();
          releaseNavigationKeys();
          setDomAttribute(document.documentElement, "data-dolphin-binding-capture", "active");
        } else {
          setDomAttribute(document.documentElement, "data-dolphin-binding-capture", "idle");
        }
      },
      getStatus() {
        return {
          supported: Boolean(getBrowserGamepads),
          connected: Array.from(connectedGamepads.values()),
          activeIndex: activeGamepadIndex,
          activeId: currentGamepad?.id || "",
          mapping: currentGamepad?.mapping || "",
          timestamp: currentGamepadTimestamp,
          nativeBufferAttached: Boolean(stateBufferPtr && stateBufferLength),
          nativeSnapshots: nativeSnapshotSequence,
        };
      },
    };
    window.DolphinBrowserInput = browserInput;
    // Qt cleans custom properties off Window and Document, but preserves the page's DOM nodes.
    document.documentElement.DolphinBrowserInput = browserInput;
    persistentBrowserInput = browserInput;
    if (Module) {
      Module.DolphinBrowserInput = browserInput;
      document.documentElement.dataset.dolphinInputModuleBridge = "ready";
    }

    // Translate the D-pad and buttons into Qt keyboard navigation. Joysticks are deliberately
    // excluded so they remain exclusive to gameplay and binding capture.
    const navigationActions = [
      {name: "up", code: "ArrowUp", key: "ArrowUp", keyCode: 38,
       active: (pad) => logicalButtonValue(pad, 12) > 0.5},
      {name: "down", code: "ArrowDown", key: "ArrowDown", keyCode: 40,
       active: (pad) => logicalButtonValue(pad, 13) > 0.5},
      {name: "left", code: "ArrowLeft", key: "ArrowLeft", keyCode: 37,
       active: (pad) => logicalButtonValue(pad, 14) > 0.5},
      {name: "right", code: "ArrowRight", key: "ArrowRight", keyCode: 39,
       active: (pad) => logicalButtonValue(pad, 15) > 0.5},
      {name: "accept", code: "Enter", key: "Enter", keyCode: 13,
       active: (pad) => logicalButtonValue(pad, 0) > 0.5 || logicalButtonValue(pad, 9) > 0.5},
      {name: "back", code: "Escape", key: "Escape", keyCode: 27,
       active: (pad) => logicalButtonValue(pad, 1) > 0.5},
      {name: "previous", code: "Tab", key: "Tab", keyCode: 9, shiftKey: true,
       active: (pad) => logicalButtonValue(pad, 4) > 0.5},
      {name: "next", code: "Tab", key: "Tab", keyCode: 9,
       active: (pad) => logicalButtonValue(pad, 5) > 0.5},
    ];
    const navigationStates = new Map();
    const qtKeyTarget = () => {
      const root = document.querySelector("#qt-shadow-container")?.shadowRoot;
      return root?.querySelector("canvas") || document.querySelector("#canvas") || document.body;
    };
    const dispatchQtKey = (action, pressed, repeat = false) => {
      const event = new BrowserKeyboardEvent(pressed ? "keydown" : "keyup", {
        key: action.key, code: action.code, keyCode: action.keyCode, which: action.keyCode,
        shiftKey: Boolean(action.shiftKey), bubbles: true, cancelable: true, repeat,
      });
      qtKeyTarget().dispatchEvent(event);
    };
    const releaseNavigationKeys = () => {
      for (const action of navigationActions) {
        const state = navigationStates.get(action.name);
        if (state?.pressed)
          dispatchQtKey(action, false);
      }
      navigationStates.clear();
    };
    const pollMenuNavigation = () => {
      // MDN explicitly requires obtaining the latest Gamepad object from getGamepads() inside the
      // update loop. This also discovers controllers that were connected before page load once the
      // user presses a button and the browser exposes them.
      refreshGamepads();
      updateGamepadButtonLatches();
      const pad = getGamepad();
      const now = browserNow();
      const activeActions = navigationActions.map((action) => Boolean(pad && action.active(pad)));

      // Keep a shared native snapshot current. This avoids dozens of synchronous pthread -> main
      // thread JavaScript calls from Dolphin's InputDetector and makes short button presses reliable.
      // Prefer Emscripten's current view after memory growth, with the heap view supplied directly
      // by native code as a reliable fallback for Qt's modularized runtime.
      const heap32 = resolveHeap32();
      if (heap32 && stateBufferPtr && stateBufferLength >= keyboardStateOffset + keyboardCodeList.length) {
        const base = stateBufferPtr >> 2;
        const atomic = typeof SharedArrayBuffer !== "undefined" &&
            heap32.buffer instanceof SharedArrayBuffer;
        const store = (index, value) => {
          if (atomic)
            Atomics.store(heap32, index, value);
          else
            heap32[index] = value;
        };
        for (let id = 0; id < buttonStateCount; ++id)
          store(base + id, Math.round(browserInput.gamepadButton(id) * stateScale));
        for (let axis = 0; axis < 4; ++axis) {
          store(base + axisStateOffset + axis * 2,
              Math.round(browserInput.gamepadAxis(axis, false) * stateScale));
          store(base + axisStateOffset + axis * 2 + 1,
              Math.round(browserInput.gamepadAxis(axis, true) * stateScale));
        }
        for (let id = 0; id < keyboardCodeList.length; ++id)
          store(base + keyboardStateOffset + id,
              browserInput.keyboard(id) ? stateScale : 0);
        ++nativeSnapshotSequence;
        setDomAttribute(document.documentElement, "data-dolphin-input-buffer", "polling");
      } else if (stateBufferPtr && stateBufferLength) {
        setDomAttribute(document.documentElement, "data-dolphin-input-buffer", "heap-unavailable");
      }

      const gameRunning = document.body.dataset.dolphinGameRunning === "1";
      const dialogOpen = document.body.dataset.dolphinDialogOpen === "1";
      // Suppress gamepad-driven UI navigation whenever a dialog (e.g. the controller mapping
      // window) is open or when the binding detector is active.  Without this, joystick axes
      // and D-pad buttons dispatch synthetic arrow/Enter/Escape keys that move the selection
      // instead of being captured by Dolphin's InputDetector.
      if (menuNavigationSuppressed || document.hidden || dialogOpen) {
        releaseNavigationKeys();
        menuNavigationReady = false;
      } else if (!menuNavigationReady) {
        // Require a neutral controller after capture/dialog transitions to prevent click-through.
        menuNavigationReady = !activeActions.some(Boolean);
      } else {
        navigationActions.forEach((action, index) => {
          const pressed = activeActions[index];
          const state = navigationStates.get(action.name) || {pressed: false, repeatAt: 0};
          if (pressed && !state.pressed) {
            dispatchQtKey(action, true);
            state.pressed = true;
            state.repeatAt = now + 380;
          } else if (!pressed && state.pressed) {
            dispatchQtKey(action, false);
            state.pressed = false;
          } else if (pressed && now >= state.repeatAt && !["accept", "back"].includes(action.name)) {
            dispatchQtKey(action, true, true);
            state.repeatAt = now + 110;
          }
          navigationStates.set(action.name, state);
        });
      }

      requestBrowserFrame(pollMenuNavigation);
    };
    requestBrowserFrame(pollMenuNavigation);

    window.addEventListener("gamepadconnected", (event) => {
      rememberGamepad(event.gamepad);
      activeGamepadIndex = event.gamepad.index;
      setDomAttribute(document.documentElement, "data-dolphin-gamepad", "connected");
      setDomAttribute(document.documentElement, "data-dolphin-gamepad-index",
          String(event.gamepad.index));
      console.log(`Dolphin WASM controller connected at index ${event.gamepad.index}: ` +
                  `${event.gamepad.id}; ${event.gamepad.buttons.length} buttons, ` +
                  `${event.gamepad.axes.length} axes, mapping=${event.gamepad.mapping || "raw"}`);
    });
    window.addEventListener("gamepaddisconnected", (event) => {
      connectedGamepads.delete(event.gamepad.index);
      if (activeGamepadIndex === event.gamepad.index)
        activeGamepadIndex = null;
      setDomAttribute(document.documentElement, "data-dolphin-gamepad", "disconnected");
      console.log(`Dolphin WASM controller disconnected: ${event.gamepad.id}`);
    });

    refreshGamepads();
    console.log("Dolphin WASM Gamepad API input installed (events + per-frame polling).");
  };

  const installQtWindowKeepAlive = () => {
    if (window.DolphinQtWindowKeepAliveInstalled)
      return;
    window.DolphinQtWindowKeepAliveInstalled = true;
    installBrowserInput();
    window.DolphinWasmCaptureGameplayScreenshot = captureGameplayScreenshot;
    console.log("Dolphin WASM browser helpers installed.");

    let observedQtRoot = null;
    const BrowserMutationObserver = window.MutationObserver;
    const fixWindows = () => {
      const root = document.querySelector("#qt-shadow-container")?.shadowRoot;
      if (!root)
        return;
      const windows = Array.from(root.querySelectorAll(
          ".qt-screen > .qt-decorated-window, .qt-screen > .qt-window"));
      const windowInfo = windows.map((win, index) => {
        const title = win.querySelector?.(":scope > .title-bar .window-name, " +
          ":scope > .qt-window-title, :scope > .window-name")?.textContent ||
          win.getAttribute?.("aria-label") || "";
        const rect = win.getBoundingClientRect();
        const isVisible = !win.hidden && win.style.display !== "none" &&
          win.style.visibility !== "hidden" && rect.width > 8 && rect.height > 8;
        const isGameplayWindow = /\[[\d.]+\s*FPS\]|Interpreter|WebGPU|HLE/i.test(title);
        const isMainWindow = /^Dolphin(?:\s|$)/i.test(title);
        const isQtRootSurface = !(` ${win.className || ""} `).includes(" has-title ") &&
          rect.width >= document.documentElement.clientWidth * 0.95 &&
          rect.height >= document.documentElement.clientHeight * 0.95;
        const isDialog = isVisible && !isQtRootSurface && !isGameplayWindow && !isMainWindow;
        return {win, index, isVisible, isGameplayWindow, isMainWindow, isDialog};
      });
      const gameplayWindowVisible = windowInfo.some((info) =>
        info.isVisible && info.isGameplayWindow);
      const dialogWindowVisible = windowInfo.some((info) => info.isDialog);

      for (const info of windowInfo) {
        const {win} = info;
        if (info.isGameplayWindow || info.isMainWindow) {
          setDomStyle(win, "display", "");
          setDomStyle(win, "visibility", "visible");
          setDomStyle(win, "opacity", "1");
          setDomStyle(win, "pointer-events", dialogWindowVisible ? "none" : "auto");
        }
        if (info.isGameplayWindow) {
          setDomStyle(win, "z-index", "2");
        } else if (info.isMainWindow) {
          setDomStyle(win, "z-index", "1");
        } else if (info.isDialog) {
          // A visible child window is an input barrier. Without this, Qt WASM can paint the
          // dialog above the main window while still routing the click to the main window below.
          setDomStyle(win, "pointer-events", "auto");
          setDomStyle(win, "z-index", String(100 + info.index));
        }
      }
      setDomAttribute(document.body, "data-dolphin-game-running", gameplayWindowVisible ? "1" : "0");
      setDomAttribute(document.body, "data-dolphin-dialog-open", dialogWindowVisible ? "1" : "0");

      if (BrowserMutationObserver && observedQtRoot !== root) {
        observedQtRoot = root;
        new BrowserMutationObserver(() => fixWindows()).observe(root, {
          childList: true,
          subtree: true,
        });
      }
    };

    window.addEventListener("focus", fixWindows);
    window.addEventListener("pointerdown", () => setTimeout(fixWindows, 0), true);
    window.setInterval(fixWindows, 500);

    // A single Escape stays available to games; a double tap toggles the maximized game view.
    let lastEscapeAt = -Infinity;
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        exitBrowserFullscreen();
        if (event.repeat)
          return;
        const now = performance.now();
        if (now - lastEscapeAt < 450) {
          lastEscapeAt = -Infinity;
          window.DolphinWasmToggleFullscreen?.();
        } else {
          lastEscapeAt = now;
        }
        return;
      }

      if ((event.key === "F9" || event.key === "PrintScreen") && !isFullscreenActive())
        captureGameplayScreenshot();
    }, true);

    window.addEventListener("pointerup", (event) => {
      if (isFullscreenActive())
        return;

      const y = event.clientY;
      const x = event.clientX;
      if (y >= 25 && y <= 78 && x >= 335 && x <= 395)
        setTimeout(captureGameplayScreenshot, 0);
    }, true);
  };

  const createWasmJitBridge = (Module) => {
    if (Module.DolphinWasmJit) return Module.DolphinWasmJit;

    const enabled = isWasmJitRequested();
    let nextModuleId = 1;
    const modules = new Map();

    const sharedImports = () => {
      const memory = Module.wasmMemory || Module.asm?.memory || Module.asm?.__memory;
      const table =
        Module.wasmTable ||
        Module.asm?.__indirect_function_table ||
        Module.asm?.__table ||
        Module.__indirect_function_table;

      if (!memory)
        throw new Error("Dolphin WASM JIT bridge cannot find the main wasm memory export");
      if (!table)
        throw new Error("Dolphin WASM JIT bridge cannot find the main indirect function table");

      return {
        env: {
          memory,
          __indirect_function_table: table,
        },
      };
    };

    const bridge = {
      enabled,
      modules,
      async compile(bytes, imports = {}) {
        if (!enabled)
          throw new Error("Dolphin WASM JIT bridge is disabled; add wasmjit=1 to opt in");

        const importObject = sharedImports();
        importObject.env = { ...importObject.env, ...(imports.env || {}) };
        for (const [moduleName, moduleImports] of Object.entries(imports)) {
          if (moduleName !== "env")
            importObject[moduleName] = moduleImports;
        }

        const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const compiledModule = await WebAssembly.compile(source);
        const instance = await WebAssembly.instantiate(compiledModule, importObject);
        const id = nextModuleId++;
        modules.set(id, { module: compiledModule, instance });
        return { id, exports: instance.exports };
      },
      release(id) {
        return modules.delete(id);
      },
    };

    Module.DolphinWasmJit = bridge;
    window.DolphinWasmJit = bridge;

    if (enabled) {
      console.log("Dolphin WASM Jitpreter enabled: hot cached-interpreter blocks are compiled " +
                  "into runtime WebAssembly traces.");
    }

    return bridge;
  };

  window.DolphinWasmJitRuntime = {
    qtLoadConfig() {
      const hostPath = queryGamePath();
      installHeadlessViewport();
      const config = {
        arguments: ["-u", USER_PATH],
        preRun: [function(Module) {
          mountPersistentUser(Module);
          seedDolphinNand(Module);
          injectPerformanceConfig(Module);
          ensureBrowserControllerConfig(Module);
          installBrowserGameLibrary(Module);
          mountTabGameDirectory(Module);
          installBrowserAudio(Module);
          installBrowserInput(Module);
          Module.DolphinPresentFrame = presentGameFrame;
          installQtWindowKeepAlive();
        }],
        onRuntimeInitialized() {
          installBrowserAudio();
          installBrowserInput();
          installQtWindowKeepAlive();
        },
      };

      if (hostPath) {
        let mountedPath = "";
        const execPathIndex = config.arguments.length + 2;
        config.arguments.push("--batch", "--exec", "/dolphin/host/game.rvz");
        config.preRun.push(function(Module) {
          mountedPath = mountQueryGame(Module, hostPath);
          config.arguments[execPathIndex] = mountedPath;
        });
      }

      if (isWasmJitRequested()) {
        console.warn("Dolphin WASM JIT runtime requested. The build exports a growable table for " +
                     "future generated modules, but the JS module bridge is disabled until it can " +
                     "run without interfering with Qt's pthread workers.");
      }

      return config;
    },
  };

  installBrowserGameLibrary();
  installBrowserAudio();
  installBrowserInput();
})();
