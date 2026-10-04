const DEVICE_ID_KEY = 'musicscale_live_device_id';
import { createClientId } from './clientId';

export function getOrCreateDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_KEY);
  if (existing) return existing;
  const id = createClientId();
  localStorage.setItem(DEVICE_ID_KEY, id);
  return id;
}

export function defaultDeviceName(): string {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || navigator.platform || 'Browser';
  const touch = navigator.maxTouchPoints > 0 ? 'Touch' : 'Desktop';
  return `${platform} · ${touch}`;
}
