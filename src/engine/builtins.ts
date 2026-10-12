/**
 * Names a language hands every file without the file saying so (#337 part C).
 *
 * `isinstance(x, int)` in Python, `Number(v)` in TypeScript, `Ok(())` in Rust.
 * None of them is a name the file forgot to import, and none of them can reach
 * a file in any repository -- so reporting them as "the file never says where
 * this came from" described a gap in the text that is not there, and left
 * bodies open that nothing was actually in doubt about. `is_stdlib_dataclass`
 * in pydantic makes exactly one call, `hasattr`, and that one name was the
 * whole of what stood between it and a verdict.
 *
 * ## Where these lists come from
 *
 * Not written by hand. Each is dumped from the language's own account of
 * itself, so there is no list-keeper to be wrong and the commands can be run
 * again when a toolchain moves:
 *
 *   ts / tsx / js  the globals of a bare ECMAScript realm, which is the
 *                  language and nothing the host added:
 *                    node -e "const vm = require('node:vm');
 *                      console.log(Object.getOwnPropertyNames(
 *                        vm.runInNewContext('globalThis')).sort().join('\n'))"
 *                  Deliberately *not* `globalThis` in Node, which also carries
 *                  `Request`, `Response`, `Headers`, `File`, `URL` and the
 *                  module names -- every one of which a repository really does
 *                  declare, and four of which are declared in this corpus.
 *
 *   python         python3 -c "import builtins; print('\n'.join(dir(builtins)))"
 *
 *   rust           the prelude and the exported macros, read out of the
 *                  toolchain's own source:
 *                    S=$(rustc --print sysroot)/lib/rustlib/src/rust/library
 *                    grep -hoE '^\s*pub use [^;]+;' \
 *                      $S/core/src/prelude/v1.rs $S/std/src/prelude/v1.rs
 *                    grep -rhoE '^\s*macro_rules! [a-z_]+' \
 *                      $S/core/src/macros/mod.rs $S/std/src/macros.rs \
 *                      $S/alloc/src/macros.rs
 *                  Macros belong in the same set because `calleeOf` reads a
 *                  `macro_invocation`'s name through its `macro` field exactly
 *                  as it reads a call's through `function`: `vec![1]` arrives
 *                  here as the bare name `vec`.
 *
 * ## The one hazard, and what it costs
 *
 * A repository can declare a name of its own that shadows one of these, and
 * then a call on that name means the repository's. The languages settle most
 * of it themselves: Python, Rust and ECMAScript modules all require a file to
 * declare or import a name before it can use one, and this is asked only where
 * the file does neither -- so a shadowing declaration somewhere else in the
 * repository cannot be what the call means.
 *
 * What the languages do not settle is a wildcard import, which brings in names
 * nothing can enumerate and could perfectly well bring in a `list` of its own.
 * `callsIn` refuses there, which is the rule `throughWildcards` already
 * applies one level up: follow only to an answer the text settles, and treat
 * anything else as the doubt it is.
 *
 * `scripts/measure-builtins.mts` is the referee. It scans all fifteen corpus
 * repositories with a text scan that shares no machinery with this reader and
 * reports every name in these lists that a repository declares for itself.
 */
import type { Language } from "./parse";

/** The globals of a bare ECMAScript realm -- the language, not the host. */
const ECMASCRIPT = [
  "AggregateError", "Array", "ArrayBuffer", "AsyncDisposableStack", "Atomics",
  "BigInt", "BigInt64Array", "BigUint64Array", "Boolean", "DataView", "Date",
  "DisposableStack", "Error", "EvalError", "FinalizationRegistry", "Float16Array",
  "Float32Array", "Float64Array", "Function", "Infinity", "Int16Array", "Int32Array",
  "Int8Array", "Intl", "Iterator", "JSON", "Map", "Math", "NaN", "Number", "Object",
  "Promise", "Proxy", "RangeError", "ReferenceError", "Reflect", "RegExp", "Set",
  "SharedArrayBuffer", "String", "SuppressedError", "Symbol", "SyntaxError",
  "TypeError", "URIError", "Uint16Array", "Uint32Array", "Uint8Array",
  "Uint8ClampedArray", "WeakMap", "WeakRef", "WeakSet", "WebAssembly", "console",
  "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent", "escape",
  "eval", "globalThis", "isFinite", "isNaN", "parseFloat", "parseInt", "undefined",
  "unescape",
];

/** `dir(builtins)`, less the dunders. */
const PYTHON = [
  "ArithmeticError", "AssertionError", "AttributeError", "BaseException",
  "BaseExceptionGroup", "BlockingIOError", "BrokenPipeError", "BufferError",
  "BytesWarning", "ChildProcessError", "ConnectionAbortedError", "ConnectionError",
  "ConnectionRefusedError", "ConnectionResetError", "DeprecationWarning", "EOFError",
  "Ellipsis", "EncodingWarning", "EnvironmentError", "Exception", "ExceptionGroup",
  "False", "FileExistsError", "FileNotFoundError", "FloatingPointError",
  "FutureWarning", "GeneratorExit", "IOError", "ImportError", "ImportWarning",
  "IndentationError", "IndexError", "InterruptedError", "IsADirectoryError",
  "KeyError", "KeyboardInterrupt", "LookupError", "MemoryError",
  "ModuleNotFoundError", "NameError", "None", "NotADirectoryError", "NotImplemented",
  "NotImplementedError", "OSError", "OverflowError", "PendingDeprecationWarning",
  "PermissionError", "ProcessLookupError", "PythonFinalizationError",
  "RecursionError", "ReferenceError", "ResourceWarning", "RuntimeError",
  "RuntimeWarning", "StopAsyncIteration", "StopIteration", "SyntaxError",
  "SyntaxWarning", "SystemError", "SystemExit", "TabError", "TimeoutError", "True",
  "TypeError", "UnboundLocalError", "UnicodeDecodeError", "UnicodeEncodeError",
  "UnicodeError", "UnicodeTranslateError", "UnicodeWarning", "UserWarning",
  "ValueError", "Warning", "ZeroDivisionError", "abs", "aiter", "all", "anext",
  "any", "ascii", "bin", "bool", "breakpoint", "bytearray", "bytes", "callable",
  "chr", "classmethod", "compile", "complex", "copyright", "credits", "delattr",
  "dict", "dir", "divmod", "enumerate", "eval", "exec", "exit", "filter", "float",
  "format", "frozenset", "getattr", "globals", "hasattr", "hash", "help", "hex",
  "id", "input", "int", "isinstance", "issubclass", "iter", "len", "license", "list",
  "locals", "map", "max", "memoryview", "min", "next", "object", "oct", "open",
  "ord", "pow", "print", "property", "quit", "range", "repr", "reversed", "round",
  "set", "setattr", "slice", "sorted", "staticmethod", "str", "sum", "super",
  "tuple", "type", "vars", "zip",
];

/** The std prelude, plus the macros std exports -- one namespace to this reader. */
const RUST = [
  "align_of", "align_of_val", "AsMut", "AsRef", "assert", "assert_eq", "assert_ne",
  "AsyncFn", "AsyncFnMut", "AsyncFnOnce", "Box", "cfg", "cfg_accessible", "cfg_eval",
  "Clone", "column", "compile_error", "concat", "concat_bytes", "const_format_args",
  "Copy", "dbg", "Debug", "debug_assert", "debug_assert_eq", "debug_assert_ne",
  "Default", "define_opaque", "deref", "derive_const", "DoubleEndedIterator", "drop",
  "Drop", "env", "eprint", "eprintln", "Eq", "Err", "ExactSizeIterator", "Extend",
  "file", "Fn", "FnMut", "FnOnce", "format", "format_args", "format_args_nl", "From",
  "Hash", "include", "include_bytes", "include_str", "Into", "IntoIterator",
  "Iterator", "line", "log_syntax", "matches", "module_path", "None", "Ok", "Option",
  "option_env", "Ord", "panic", "PartialEq", "PartialOrd", "print", "println",
  "Result", "Send", "size_of", "size_of_val", "Sized", "Some", "String", "stringify",
  "Sync", "todo", "ToOwned", "ToString", "trace_macros", "type_ascribe",
  "unimplemented", "Unpin", "unreachable", "vec", "Vec", "write", "writeln",
];

/**
 * What a browser or Node puts in scope, less what ECMAScript already does
 * (#468). Kept apart from `ECMASCRIPT` because it is the host's, not the
 * language's: TypeScript 5.9's `lib.dom.d.ts`, every `declare function` and
 * every `declare var X: { prototype: X; new(...) }`, plus Node's globals:
 *
 *   node -e "const t = require('fs').readFileSync(
 *     'node_modules/typescript/lib/lib.dom.d.ts', 'utf8');
 *     /^declare function (\w+)/gm and
 *     /^declare var (\w+): \{\n    prototype: [^;]+;\n    new\(/gm"
 *
 * `Request`, `Response`, `URL` and `File` are names a repository declares too,
 * which is why this list was once left out. That worry is a file's scope, not
 * a list's: a module can use its own `Response` only by declaring or importing
 * it, and `lookUp` asks this only after both came back empty.
 */
const HOST = [
  "AbortController", "AbortSignal", "AbstractRange", "AnalyserNode", "Animation",
  "AnimationEffect", "AnimationEvent", "AnimationPlaybackEvent", "AnimationTimeline",
  "Attr", "AudioBuffer", "AudioBufferSourceNode", "AudioContext", "AudioData",
  "AudioDecoder", "AudioDestinationNode", "AudioEncoder", "AudioListener", "AudioNode",
  "AudioParam", "AudioParamMap", "AudioProcessingEvent", "AudioScheduledSourceNode",
  "AudioWorklet", "AudioWorkletNode", "AuthenticatorAssertionResponse",
  "AuthenticatorAttestationResponse", "AuthenticatorResponse", "BarProp",
  "BaseAudioContext", "BeforeUnloadEvent", "BiquadFilterNode", "Blob", "BlobEvent",
  "BroadcastChannel", "Buffer", "ByteLengthQueuingStrategy", "CDATASection",
  "CSPViolationReportBody", "CSSAnimation", "CSSConditionRule", "CSSContainerRule",
  "CSSCounterStyleRule", "CSSFontFaceRule", "CSSFontFeatureValuesRule",
  "CSSFontPaletteValuesRule", "CSSGroupingRule", "CSSImageValue", "CSSImportRule",
  "CSSKeyframeRule", "CSSKeyframesRule", "CSSKeywordValue", "CSSLayerBlockRule",
  "CSSLayerStatementRule", "CSSMathClamp", "CSSMathInvert", "CSSMathMax", "CSSMathMin",
  "CSSMathNegate", "CSSMathProduct", "CSSMathSum", "CSSMathValue",
  "CSSMatrixComponent", "CSSMediaRule", "CSSNamespaceRule", "CSSNestedDeclarations",
  "CSSNumericArray", "CSSNumericValue", "CSSPageRule", "CSSPerspective",
  "CSSPropertyRule", "CSSRotate", "CSSRule", "CSSRuleList", "CSSScale", "CSSScopeRule",
  "CSSSkew", "CSSSkewX", "CSSSkewY", "CSSStartingStyleRule", "CSSStyleDeclaration",
  "CSSStyleRule", "CSSStyleSheet", "CSSStyleValue", "CSSSupportsRule",
  "CSSTransformComponent", "CSSTransformValue", "CSSTransition", "CSSTranslate",
  "CSSUnitValue", "CSSUnparsedValue", "CSSVariableReferenceValue",
  "CSSViewTransitionRule", "Cache", "CacheStorage", "CanvasCaptureMediaStreamTrack",
  "CanvasGradient", "CanvasPattern", "CanvasRenderingContext2D", "CaretPosition",
  "ChannelMergerNode", "ChannelSplitterNode", "CharacterData", "Clipboard",
  "ClipboardEvent", "ClipboardItem", "CloseEvent", "Comment", "CompositionEvent",
  "CompressionStream", "ConstantSourceNode", "ContentVisibilityAutoStateChangeEvent",
  "ConvolverNode", "CookieChangeEvent", "CookieStore", "CookieStoreManager",
  "CountQueuingStrategy", "Credential", "CredentialsContainer", "Crypto", "CryptoKey",
  "CustomElementRegistry", "CustomStateSet", "DOMException", "DOMImplementation",
  "DOMMatrix", "DOMMatrixReadOnly", "DOMParser", "DOMPoint", "DOMPointReadOnly",
  "DOMQuad", "DOMRect", "DOMRectList", "DOMRectReadOnly", "DOMStringList",
  "DOMStringMap", "DOMTokenList", "DataTransfer", "DataTransferItem",
  "DataTransferItemList", "DecompressionStream", "DelayNode", "DeviceMotionEvent",
  "DeviceOrientationEvent", "Document", "DocumentFragment", "DocumentTimeline",
  "DocumentType", "DragEvent", "DynamicsCompressorNode", "Element", "ElementInternals",
  "EncodedAudioChunk", "EncodedVideoChunk", "ErrorEvent", "Event", "EventCounts",
  "EventSource", "EventTarget", "External", "File", "FileList", "FileReader",
  "FileSystem", "FileSystemDirectoryEntry", "FileSystemDirectoryHandle",
  "FileSystemDirectoryReader", "FileSystemEntry", "FileSystemFileEntry",
  "FileSystemFileHandle", "FileSystemHandle", "FileSystemWritableFileStream",
  "FocusEvent", "FontFace", "FontFaceSet", "FontFaceSetLoadEvent", "FormData",
  "FormDataEvent", "FragmentDirective", "GainNode", "Gamepad", "GamepadButton",
  "GamepadEvent", "GamepadHapticActuator", "Geolocation", "GeolocationCoordinates",
  "GeolocationPosition", "GeolocationPositionError", "HTMLAllCollection",
  "HTMLAnchorElement", "HTMLAreaElement", "HTMLAudioElement", "HTMLBRElement",
  "HTMLBaseElement", "HTMLBodyElement", "HTMLButtonElement", "HTMLCanvasElement",
  "HTMLCollection", "HTMLDListElement", "HTMLDataElement", "HTMLDataListElement",
  "HTMLDetailsElement", "HTMLDialogElement", "HTMLDirectoryElement", "HTMLDivElement",
  "HTMLDocument", "HTMLElement", "HTMLEmbedElement", "HTMLFieldSetElement",
  "HTMLFontElement", "HTMLFormControlsCollection", "HTMLFormElement",
  "HTMLFrameElement", "HTMLFrameSetElement", "HTMLHRElement", "HTMLHeadElement",
  "HTMLHeadingElement", "HTMLHtmlElement", "HTMLIFrameElement", "HTMLImageElement",
  "HTMLInputElement", "HTMLLIElement", "HTMLLabelElement", "HTMLLegendElement",
  "HTMLLinkElement", "HTMLMapElement", "HTMLMarqueeElement", "HTMLMediaElement",
  "HTMLMenuElement", "HTMLMetaElement", "HTMLMeterElement", "HTMLModElement",
  "HTMLOListElement", "HTMLObjectElement", "HTMLOptGroupElement", "HTMLOptionElement",
  "HTMLOptionsCollection", "HTMLOutputElement", "HTMLParagraphElement",
  "HTMLParamElement", "HTMLPictureElement", "HTMLPreElement", "HTMLProgressElement",
  "HTMLQuoteElement", "HTMLScriptElement", "HTMLSelectElement", "HTMLSlotElement",
  "HTMLSourceElement", "HTMLSpanElement", "HTMLStyleElement",
  "HTMLTableCaptionElement", "HTMLTableCellElement", "HTMLTableColElement",
  "HTMLTableElement", "HTMLTableRowElement", "HTMLTableSectionElement",
  "HTMLTemplateElement", "HTMLTextAreaElement", "HTMLTimeElement", "HTMLTitleElement",
  "HTMLTrackElement", "HTMLUListElement", "HTMLUnknownElement", "HTMLVideoElement",
  "HashChangeEvent", "Headers", "Highlight", "HighlightRegistry", "History",
  "IDBCursor", "IDBCursorWithValue", "IDBDatabase", "IDBFactory", "IDBIndex",
  "IDBKeyRange", "IDBObjectStore", "IDBOpenDBRequest", "IDBRequest", "IDBTransaction",
  "IDBVersionChangeEvent", "IIRFilterNode", "IdleDeadline", "ImageBitmap",
  "ImageBitmapRenderingContext", "ImageCapture", "ImageData", "ImageDecoder",
  "ImageTrack", "ImageTrackList", "InputDeviceInfo", "InputEvent",
  "IntersectionObserver", "IntersectionObserverEntry", "KeyboardEvent",
  "KeyframeEffect", "LargestContentfulPaint", "Location", "Lock", "LockManager",
  "MIDIAccess", "MIDIConnectionEvent", "MIDIInput", "MIDIInputMap", "MIDIMessageEvent",
  "MIDIOutput", "MIDIOutputMap", "MIDIPort", "MathMLElement", "MediaCapabilities",
  "MediaDeviceInfo", "MediaDevices", "MediaElementAudioSourceNode",
  "MediaEncryptedEvent", "MediaError", "MediaKeyMessageEvent", "MediaKeySession",
  "MediaKeyStatusMap", "MediaKeySystemAccess", "MediaKeys", "MediaList",
  "MediaMetadata", "MediaQueryList", "MediaQueryListEvent", "MediaRecorder",
  "MediaSession", "MediaSource", "MediaSourceHandle", "MediaStream",
  "MediaStreamAudioDestinationNode", "MediaStreamAudioSourceNode", "MediaStreamTrack",
  "MediaStreamTrackEvent", "MessageChannel", "MessagePort", "MimeType",
  "MimeTypeArray", "MouseEvent", "MutationObserver", "MutationRecord", "NamedNodeMap",
  "NavigationActivation", "NavigationHistoryEntry", "NavigationPreloadManager",
  "Navigator", "NavigatorLogin", "Node", "NodeIterator", "NodeList", "Notification",
  "OfflineAudioCompletionEvent", "OfflineAudioContext", "OffscreenCanvas",
  "OffscreenCanvasRenderingContext2D", "OscillatorNode", "OverconstrainedError",
  "PageRevealEvent", "PageSwapEvent", "PageTransitionEvent", "PannerNode", "Path2D",
  "PaymentAddress", "PaymentMethodChangeEvent", "PaymentRequest",
  "PaymentRequestUpdateEvent", "PaymentResponse", "Performance", "PerformanceEntry",
  "PerformanceEventTiming", "PerformanceMark", "PerformanceMeasure",
  "PerformanceNavigation", "PerformanceNavigationTiming", "PerformanceObserver",
  "PerformanceObserverEntryList", "PerformancePaintTiming",
  "PerformanceResourceTiming", "PerformanceServerTiming", "PerformanceTiming",
  "PeriodicWave", "PermissionStatus", "Permissions", "PictureInPictureEvent",
  "PictureInPictureWindow", "Plugin", "PluginArray", "PointerEvent", "PopStateEvent",
  "ProcessingInstruction", "ProgressEvent", "PromiseRejectionEvent",
  "PublicKeyCredential", "PushManager", "PushSubscription", "PushSubscriptionOptions",
  "RTCCertificate", "RTCDTMFSender", "RTCDTMFToneChangeEvent", "RTCDataChannel",
  "RTCDataChannelEvent", "RTCDtlsTransport", "RTCEncodedAudioFrame",
  "RTCEncodedVideoFrame", "RTCError", "RTCErrorEvent", "RTCIceCandidate",
  "RTCIceTransport", "RTCPeerConnection", "RTCPeerConnectionIceErrorEvent",
  "RTCPeerConnectionIceEvent", "RTCRtpReceiver", "RTCRtpScriptTransform",
  "RTCRtpSender", "RTCRtpTransceiver", "RTCSctpTransport", "RTCSessionDescription",
  "RTCStatsReport", "RTCTrackEvent", "RadioNodeList", "Range",
  "ReadableByteStreamController", "ReadableStream", "ReadableStreamBYOBReader",
  "ReadableStreamBYOBRequest", "ReadableStreamDefaultController", "RemotePlayback",
  "Report", "ReportBody", "ReportingObserver", "Request", "ResizeObserver",
  "ResizeObserverEntry", "ResizeObserverSize", "Response", "SVGAElement", "SVGAngle",
  "SVGAnimateElement", "SVGAnimateMotionElement", "SVGAnimateTransformElement",
  "SVGAnimatedAngle", "SVGAnimatedBoolean", "SVGAnimatedEnumeration",
  "SVGAnimatedInteger", "SVGAnimatedLength", "SVGAnimatedLengthList",
  "SVGAnimatedNumber", "SVGAnimatedNumberList", "SVGAnimatedPreserveAspectRatio",
  "SVGAnimatedRect", "SVGAnimatedString", "SVGAnimatedTransformList",
  "SVGAnimationElement", "SVGCircleElement", "SVGClipPathElement",
  "SVGComponentTransferFunctionElement", "SVGDefsElement", "SVGDescElement",
  "SVGElement", "SVGEllipseElement", "SVGFEBlendElement", "SVGFEColorMatrixElement",
  "SVGFEComponentTransferElement", "SVGFECompositeElement",
  "SVGFEConvolveMatrixElement", "SVGFEDiffuseLightingElement",
  "SVGFEDisplacementMapElement", "SVGFEDistantLightElement", "SVGFEDropShadowElement",
  "SVGFEFloodElement", "SVGFEFuncAElement", "SVGFEFuncBElement", "SVGFEFuncGElement",
  "SVGFEFuncRElement", "SVGFEGaussianBlurElement", "SVGFEImageElement",
  "SVGFEMergeElement", "SVGFEMergeNodeElement", "SVGFEMorphologyElement",
  "SVGFEOffsetElement", "SVGFEPointLightElement", "SVGFESpecularLightingElement",
  "SVGFESpotLightElement", "SVGFETileElement", "SVGFETurbulenceElement",
  "SVGFilterElement", "SVGForeignObjectElement", "SVGGElement", "SVGGeometryElement",
  "SVGGradientElement", "SVGGraphicsElement", "SVGImageElement", "SVGLength",
  "SVGLengthList", "SVGLineElement", "SVGLinearGradientElement", "SVGMPathElement",
  "SVGMarkerElement", "SVGMaskElement", "SVGMetadataElement", "SVGNumber",
  "SVGNumberList", "SVGPathElement", "SVGPatternElement", "SVGPointList",
  "SVGPolygonElement", "SVGPolylineElement", "SVGPreserveAspectRatio",
  "SVGRadialGradientElement", "SVGRectElement", "SVGSVGElement", "SVGScriptElement",
  "SVGSetElement", "SVGStopElement", "SVGStringList", "SVGStyleElement",
  "SVGSwitchElement", "SVGSymbolElement", "SVGTSpanElement", "SVGTextContentElement",
  "SVGTextElement", "SVGTextPathElement", "SVGTextPositioningElement",
  "SVGTitleElement", "SVGTransform", "SVGTransformList", "SVGUnitTypes",
  "SVGUseElement", "SVGViewElement", "Screen", "ScreenOrientation",
  "ScriptProcessorNode", "SecurityPolicyViolationEvent", "Selection", "ServiceWorker",
  "ServiceWorkerContainer", "ServiceWorkerRegistration", "ShadowRoot", "SharedWorker",
  "SourceBuffer", "SourceBufferList", "SpeechRecognitionAlternative",
  "SpeechRecognitionResult", "SpeechRecognitionResultList", "SpeechSynthesis",
  "SpeechSynthesisErrorEvent", "SpeechSynthesisEvent", "SpeechSynthesisUtterance",
  "SpeechSynthesisVoice", "StaticRange", "StereoPannerNode", "Storage", "StorageEvent",
  "StorageManager", "StylePropertyMap", "StylePropertyMapReadOnly", "StyleSheet",
  "StyleSheetList", "SubmitEvent", "SubtleCrypto", "Text", "TextDecoder",
  "TextDecoderStream", "TextEncoder", "TextEncoderStream", "TextEvent", "TextMetrics",
  "TextTrack", "TextTrackCue", "TextTrackCueList", "TextTrackList", "TimeRanges",
  "ToggleEvent", "Touch", "TouchEvent", "TouchList", "TrackEvent",
  "TransformStreamDefaultController", "TransitionEvent", "TreeWalker", "UIEvent",
  "URL", "URLSearchParams", "UserActivation", "VTTCue", "VTTRegion", "ValidityState",
  "VideoColorSpace", "VideoDecoder", "VideoEncoder", "VideoFrame",
  "VideoPlaybackQuality", "ViewTransition", "ViewTransitionTypeSet", "VisualViewport",
  "WakeLock", "WakeLockSentinel", "WaveShaperNode", "WebGL2RenderingContext",
  "WebGLActiveInfo", "WebGLBuffer", "WebGLContextEvent", "WebGLFramebuffer",
  "WebGLProgram", "WebGLQuery", "WebGLRenderbuffer", "WebGLRenderingContext",
  "WebGLSampler", "WebGLShader", "WebGLShaderPrecisionFormat", "WebGLSync",
  "WebGLTexture", "WebGLTransformFeedback", "WebGLUniformLocation",
  "WebGLVertexArrayObject", "WebSocket", "WebTransport",
  "WebTransportBidirectionalStream", "WebTransportDatagramDuplexStream",
  "WebTransportError", "WheelEvent", "Window", "Worker", "Worklet",
  "WritableStreamDefaultController", "XMLDocument", "XMLHttpRequest",
  "XMLHttpRequestEventTarget", "XMLHttpRequestUpload", "XMLSerializer",
  "XPathEvaluator", "XPathExpression", "XPathResult", "XSLTProcessor",
  "addEventListener", "alert", "atob", "blur", "btoa", "cancelAnimationFrame",
  "cancelIdleCallback", "captureEvents", "clearImmediate", "clearInterval",
  "clearTimeout", "close", "confirm", "createImageBitmap", "dispatchEvent", "fetch",
  "focus", "getComputedStyle", "getSelection", "global", "matchMedia", "moveBy",
  "moveTo", "open", "postMessage", "print", "process", "prompt", "queueMicrotask",
  "releaseEvents", "removeEventListener", "reportError", "requestAnimationFrame",
  "requestIdleCallback", "require", "resizeBy", "resizeTo", "scroll", "scrollBy",
  "scrollTo", "setImmediate", "setInterval", "setTimeout", "stop", "structuredClone",
];

/**
 * A total record, so a new language cannot quietly inherit somebody else's
 * built-ins -- which would be the worst shape this could fail in: a name
 * placed outside the repository on the strength of a list that is not about
 * that language at all.
 */
export const PROVIDED: Record<Language, ReadonlySet<string>> = {
  ts: new Set(ECMASCRIPT),
  tsx: new Set(ECMASCRIPT),
  js: new Set(ECMASCRIPT),
  python: new Set(PYTHON),
  rust: new Set(RUST),
};

/** Whether a browser or Node puts this name in a TypeScript or JavaScript file's scope (#468). */
export function providedByHost(name: string, language: Language): boolean {
  return language !== "python" && language !== "rust" && HOST_NAMES.has(name);
}

const HOST_NAMES: ReadonlySet<string> = new Set(HOST);

/** Whether the language itself puts this name in every file's scope. */
export function providedByLanguage(name: string, language: Language): boolean {
  return PROVIDED[language].has(name);
}
