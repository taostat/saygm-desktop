export function getLocalDeviceName(platform: string): 'Mac' | 'computer' {
  return platform === 'darwin' ? 'Mac' : 'computer';
}
