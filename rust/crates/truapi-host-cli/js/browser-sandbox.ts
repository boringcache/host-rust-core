import { installContainer } from "../../../../js/container/src/container.ts";

const runtime = window as Window & {
  __HOST_API_PORT__?: MessagePort;
  __HOST_WEBVIEW_MARK__?: boolean;
  __truapi_localhost?: { url: string };
};
if (typeof runtime.__truapi_localhost?.url !== "string")
  throw new Error("CLI frame endpoint is missing");

const channel = new MessageChannel();
runtime.__HOST_API_PORT__ = channel.port1;
runtime.__HOST_WEBVIEW_MARK__ = true;
installContainer(channel);
