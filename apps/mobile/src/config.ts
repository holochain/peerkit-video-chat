import Constants from "expo-constants";

interface ExpoExtra {
  relayMultiaddr?: string;
  iceServerUrls?: string[];
}

function expoExtra(): ExpoExtra {
  const constants = Constants as unknown as {
    expoConfig?: {
      extra?: ExpoExtra;
    };
  };
  return constants.expoConfig?.extra ?? {};
}

export function configuredRelayMultiaddr(): string {
  return expoExtra().relayMultiaddr?.trim() ?? "";
}

export function configuredIceServerUrls(): string[] {
  const urls = (expoExtra().iceServerUrls ?? [])
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  return urls.length > 0 ? urls : ["stun:stun.cloudflare.com:3478"];
}

export function configuredIceServers(): RTCIceServer[] {
  return configuredIceServerUrls().map((url) => ({ urls: url }));
}
