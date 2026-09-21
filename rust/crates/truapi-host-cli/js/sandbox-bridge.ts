const runtime = window as Window & {
  __HOST_API_PORT__?: MessagePort;
  __HOST_WEBVIEW_MARK__?: boolean;
  __truapi_cli_frame_url__?: string;
  __truapi_host_channel__?: MessageChannel;
  __truapi_localhost?: { url: string };
  __truapi_policy__?: { mediaAllowed: boolean; webRtcAllowed: boolean };
};
const frameUrl = runtime.__truapi_cli_frame_url__;
delete runtime.__truapi_cli_frame_url__;
if (typeof frameUrl !== "string")
  throw new Error("CLI frame endpoint is missing");

const channel = new MessageChannel();
runtime.__HOST_API_PORT__ = channel.port1;
runtime.__HOST_WEBVIEW_MARK__ = true;
runtime.__truapi_host_channel__ = channel;
runtime.__truapi_localhost = { url: frameUrl };
runtime.__truapi_policy__ = { mediaAllowed: false, webRtcAllowed: false };

export {};
