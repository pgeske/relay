import { hostname, networkInterfaces } from "node:os";
import QRCode from "qrcode";
import { SERVER_PORT } from "./paths.ts";
import { loadToken } from "./token.ts";

/** 100.64.0.0/10, the range Tailscale hands out. */
const TAILSCALE_IPV4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/** Address the phone should use: Tailscale works anywhere, a LAN address only at home. */
function preferredAddress(): string | null {
  const addresses = Object.values(networkInterfaces())
    .flatMap((infos) => infos ?? [])
    .filter((info) => info.family === "IPv4" && !info.internal)
    .map((info) => info.address);
  return addresses.find((address) => TAILSCALE_IPV4.test(address)) ?? addresses.find((address) => PRIVATE_IPV4.test(address)) ?? null;
}

/** Prints a QR code that adds this computer to the Relay iPhone app when scanned. */
export async function printPairing(addressOverride: string | undefined): Promise<void> {
  const address = addressOverride ?? preferredAddress();
  if (!address) throw new Error("could not find a Tailscale or LAN address; pass one: relay pair <address>");

  const serverUrl = `http://${address}:${SERVER_PORT}`;
  const name = hostname().replace(/\.local$/, "");
  const link = `relay://pair?${new URLSearchParams({ url: serverUrl, token: loadToken(), name })}`;

  console.log(await QRCode.toString(link, { type: "terminal", small: true }));
  console.log("Scan with the iPhone Camera app to add this computer to Relay.\n");
  console.log(`  name   ${name}`);
  console.log(`  url    ${serverUrl}`);
  console.log(`  token  ${loadToken()}`);
  console.log("\nThe phone server must be running: relay server install");
}
