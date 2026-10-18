import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { AudioApiServer } from '../src/audio/audioApi';
import { NestLiveAudioRuntime } from '../src/audio/audioRuntime';
import { renderNestLiveLocalConsole } from '../src/runtime/localConsole';
it('permits only the generated setup script and offers both phone network QR choices', async () => {
  const api = new AudioApiServer({
    host: '127.0.0.1', port: 0, runtime: new NestLiveAudioRuntime(), authenticate: () => false,
    localConsoleHtml: nonce => renderNestLiveLocalConsole({nonce, displayName:'Cambé',
      pairUrl:'http://192.168.18.8:4317/', pairUrls:[
        {label:'OBPC <PC>',url:'http://192.168.18.8:4317/'},
        {label:'SOM',url:'http://192.168.200.2:4317/'}
      ], pairings:[], providers:[]})
  });
  await api.start();
  const address = (api as unknown as {server:{address():AddressInfo}}).server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/local`);
    const html = await response.text();
    const nonce = /<script nonce="([^"]+)"/.exec(html)?.[1];
    expect(nonce).toBeTruthy();
    expect(response.headers.get('content-security-policy')).toContain(`script-src 'nonce-${nonce}'`);
    expect(html).toContain('OBPC &lt;PC&gt;');
    expect(html).toContain('http://192.168.200.2:4317/');
    const second = await fetch(`http://127.0.0.1:${address.port}/local`);
    expect(second.headers.get('content-security-policy')).not.toContain(`nonce-${nonce}`);
    await second.text();
  } finally { await api.close(); }
});
