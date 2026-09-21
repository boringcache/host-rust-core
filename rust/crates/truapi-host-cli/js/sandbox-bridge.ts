import { createWebSocketProvider } from "@parity/truapi";

const runtime = window as Window & {
  __HOST_API_PORT__?: MessagePort;
  __HOST_WEBVIEW_MARK__?: boolean;
  __truapi_cli_frame_url__?: string;
  __truapi_localhost?: { url: string };
  __truapi_policy__?: { mediaAllowed: boolean; webRtcAllowed: boolean };
};
const frameUrl = runtime.__truapi_cli_frame_url__;
delete runtime.__truapi_cli_frame_url__;
if (typeof frameUrl !== "string")
  throw new Error("CLI frame endpoint is missing");

const endpoint = new URL(frameUrl);
endpoint.searchParams.set("execution", crypto.randomUUID());
const url = endpoint.href;
const provider = createWebSocketProvider(url);
const channel = new MessageChannel();
channel.port2.onmessage = ({ data }) => {
  try {
    provider.postMessage(data);
  } catch {
    provider.dispose();
  }
};
channel.port2.start();
provider.subscribe((message) => channel.port2.postMessage(message));
provider.subscribeClose?.(() => {
  channel.port1.dispatchEvent(new Event("messageerror"));
  channel.port1.close();
  channel.port2.close();
});
window.addEventListener("pagehide", () => provider.dispose(), { once: true });
runtime.__HOST_API_PORT__ = channel.port1;
runtime.__HOST_WEBVIEW_MARK__ = true;
runtime.__truapi_localhost = { url };
runtime.__truapi_policy__ = { mediaAllowed: false, webRtcAllowed: false };
