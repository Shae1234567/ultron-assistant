import os from 'node:os';

/**
 * Local + public IP lookup. Local IP is derived from the same
 * first-non-internal-IPv4 technique used in remoteServer.ts's getLanIp().
 * Public IP is fetched from ipify (free, keyless). Losing internet access
 * shouldn't take down the whole call - a local IP is still useful offline,
 * so only fail outright if neither could be determined.
 */

export interface IpInfo { publicIp?: string; localIp?: string }

/** Finds the first non-internal IPv4 address across all network interfaces. */
function getLocalIp(): string | undefined {
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      const addrs = interfaces[name];
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          return addr.address;
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function getPublicIp(): Promise<string | undefined> {
  try {
    const res = await fetch('https://api.ipify.org?format=json');
    if (!res.ok) return undefined;
    const data = (await res.json()) as { ip?: unknown };
    return typeof data.ip === 'string' ? data.ip : undefined;
  } catch {
    return undefined;
  }
}

export async function getIpInfo(): Promise<{ ok: boolean; info?: IpInfo; error?: string }> {
  try {
    const localIp = getLocalIp();
    const publicIp = await getPublicIp();

    if (!localIp && !publicIp) {
      return { ok: false, error: 'Could not determine local or public IP address.' };
    }

    return { ok: true, info: { publicIp, localIp } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
