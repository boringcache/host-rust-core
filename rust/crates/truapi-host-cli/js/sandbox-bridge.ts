const runtime = window as Window & {
  __HOST_API_PORT__?: MessagePort;
  __HOST_WEBVIEW_MARK__?: boolean;
  __truapi_cli_frame_url__?: string;
  __truapi_network_port__?: {
    postMessage(frame: Uint8Array): void;
    close(): void;
    onmessage: ((event: { data: Uint8Array }) => void) | null;
    onmessageerror: (() => void) | null;
  };
  __truapi_policy__?: { mediaAllowed: boolean; webRtcAllowed: boolean };
};
const frameUrl = runtime.__truapi_cli_frame_url__;
delete runtime.__truapi_cli_frame_url__;
if (typeof frameUrl !== "string")
  throw new Error("CLI frame endpoint is missing");

const apply = Reflect.apply;
const NativeBytes = Uint8Array;
const NativeError = Error;
const NativeEvent = Event;
const descriptor = Object.getOwnPropertyDescriptor;
const bytesPrototype = Object.getPrototypeOf(NativeBytes.prototype);
const bytesLength = descriptor(bytesPrototype, "length")!.get!;
const bytesType = descriptor(bytesPrototype, Symbol.toStringTag)!.get!;
const messageData = descriptor(MessageEvent.prototype, "data")!.get!;
const socketSend = WebSocket.prototype.send;
const socketClose = WebSocket.prototype.close;
const portSend = MessagePort.prototype.postMessage;
const portClose = MessagePort.prototype.close;
const dispatch = EventTarget.prototype.dispatchEvent;
const socket = new WebSocket(frameUrl);
socket.binaryType = "arraybuffer";
const channel = new MessageChannel();
let open = false;
let closed = false;
type Queued = { frame: Uint8Array; next: Queued | null };
let pending: Queued | null = null;
let tail: Queued | null = null;

// Reserve '~' in request IDs so public calls cannot receive private replies.
function envelope(frame: Uint8Array): {
  width: number;
  length: number;
  size: number;
} {
  if (apply(bytesType, frame, []) !== "Uint8Array")
    throw new NativeError("Expected a binary TrUAPI frame");
  const size = apply(bytesLength, frame, []) as number;
  const width = 1 << (frame[0]! & 3);
  if (width > 4 || size < width) throw new NativeError("Invalid TrUAPI frame");
  let compact = 0;
  for (let index = 0; index < width; index++)
    compact += frame[index]! * 2 ** (index * 8);
  const length = compact >>> 2;
  if (size < width + length + 3)
    throw new NativeError("Truncated TrUAPI frame");
  return { width, length, size };
}

function privateFrame(frame: Uint8Array, remove: boolean): Uint8Array {
  const { width, length, size } = envelope(frame);
  const nextLength = length + (remove ? -1 : 1);
  if (nextLength < 0 || nextLength >= 2 ** 30)
    throw new NativeError("Invalid TrUAPI request ID");
  const nextWidth = nextLength < 64 ? 1 : nextLength < 16384 ? 2 : 4;
  let compact =
    nextLength * 4 + (nextWidth === 1 ? 0 : nextWidth === 2 ? 1 : 2);
  const output = new NativeBytes(size - width + nextWidth + (remove ? -1 : 1));
  for (let index = 0; index < nextWidth; index++) {
    output[index] = compact & 255;
    compact >>>= 8;
  }
  if (!remove) output[nextWidth] = 126;
  const source = width + (remove ? 1 : 0);
  const target = nextWidth + (remove ? 0 : 1);
  for (let index = source; index < size; index++)
    output[target + index - source] = frame[index]!;
  return output;
}

function stop(error?: unknown): void {
  if (closed) return;
  closed = true;
  pending = tail = null;
  privatePort.onmessageerror?.();
  apply(dispatch, channel.port1, [new NativeEvent("messageerror")]);
  apply(portClose, channel.port1, []);
  apply(portClose, channel.port2, []);
  apply(socketClose, socket, []);
  if (error) console.error("TrUAPI connection failed:", error);
}

function send(frame: Uint8Array): void {
  if (closed) throw new NativeError("TrUAPI connection is closed");
  if (open) apply(socketSend, socket, [frame]);
  else {
    const entry: Queued = { frame, next: null };
    if (tail) tail.next = entry;
    else pending = entry;
    tail = entry;
  }
}

const privatePort = {
  onmessage: null as ((event: { data: Uint8Array }) => void) | null,
  onmessageerror: null as (() => void) | null,
  postMessage(frame: Uint8Array) {
    send(privateFrame(frame, false));
  },
  close() {
    stop();
  },
};
channel.port2.onmessage = (event) => {
  try {
    const frame = apply(messageData, event, []) as Uint8Array;
    const { width, length } = envelope(frame);
    if (length && frame[width] === 126)
      throw new NativeError("Product request uses a private authorization ID");
    send(frame);
  } catch (error) {
    stop(error);
  }
};
channel.port2.start();
socket.addEventListener("open", () => {
  if (closed) return;
  open = true;
  try {
    while (pending) {
      const entry = pending;
      pending = entry.next;
      apply(socketSend, socket, [entry.frame]);
    }
    tail = null;
  } catch (error) {
    stop(error);
  }
});
socket.addEventListener("message", (event) => {
  if (closed) return;
  try {
    const frame = new NativeBytes(apply(messageData, event, []));
    const { width, length } = envelope(frame);
    if (length && frame[width] === 126)
      privatePort.onmessage?.({ data: privateFrame(frame, true) });
    else apply(portSend, channel.port2, [frame]);
  } catch (error) {
    stop(error);
  }
});
socket.addEventListener("error", () =>
  stop(new NativeError("TrUAPI frame connection failed")),
);
socket.addEventListener("close", () =>
  stop(new NativeError("TrUAPI frame connection closed")),
);
window.addEventListener("pagehide", () => stop(), { once: true });
runtime.__HOST_API_PORT__ = channel.port1;
runtime.__HOST_WEBVIEW_MARK__ = true;
runtime.__truapi_network_port__ = privatePort;
runtime.__truapi_policy__ = { mediaAllowed: false, webRtcAllowed: false };

export {};
